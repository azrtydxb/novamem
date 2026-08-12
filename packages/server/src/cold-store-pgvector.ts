/**
 * pgvector cold store — Phase 8 of the Mem0-alignment plan.
 *
 * A drop-in alternative to the Qdrant `ColdStore` (selected with
 * `NOVAMEM_COLD_PROVIDER=pgvector`) that keeps vectors in Postgres
 * itself, collapsing the minimum deployment to one database plus an
 * embedder. Qdrant remains the default and the scale-out option.
 *
 * Semantics differences vs Qdrant, on purpose and documented:
 *
 *  - **Isolation is a WHERE clause, not a collection.** Qdrant gives
 *    each user×namespace its own collection, making cross-tenant reads
 *    structurally impossible. Here all vectors share one table and every
 *    query filters on (user_id, project_id, namespace). The route layer
 *    remains the real access boundary either way; the tests in
 *    cold-store-pgvector.test.ts lock the filter discipline.
 *  - **No legacy-collection migration reads.** The dual-read of
 *    pre-issue-#20 collections is Qdrant-history; a pgvector deployment
 *    starts clean.
 *  - **Writes are transactional with nothing** (yet): the engine still
 *    treats cold upserts as a separate step with the `embedded_at`
 *    self-heal. Folding the vector write into the warm INSERT is a
 *    follow-up once this provider has passed its gates — done here it
 *    would change engine semantics per provider.
 *
 * Filtered-ANN caveat: per-tenant WHERE filters are pgvector's classic
 * recall trap (the HNSW walk finds global neighbours, the filter
 * discards them). `hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8)
 * is enabled per-query so the scan keeps walking until k survivors are
 * found; on older pgvector the SET fails and is deliberately ignored —
 * the parity gate, not this comment, decides whether that is good
 * enough.
 */
import { Pool } from "pg";

export interface PgVectorColdStoreConfig {
  /** Postgres connection string. Usually the warm store's own database. */
  url: string;
  /** Embedding dimensionality — becomes the vector column's type. */
  vectorSize: number;
  timeoutMs?: number;
}

const TABLE = "memory_vectors";

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class PgVectorColdStore {
  private pool: Pool;
  private readonly dim: number;
  private ready: Promise<void> | null = null;

  constructor(cfg: PgVectorColdStoreConfig) {
    this.pool = new Pool({
      connectionString: cfg.url,
      statement_timeout: cfg.timeoutMs ?? 15_000,
      max: 10,
    });
    this.dim = cfg.vectorSize;
  }

  /** Idempotent DDL, run once per process on first use. The vector
   *  column's dimensionality comes from config (mirrors Qdrant, where
   *  collections are created with the configured size); a dimension
   *  mismatch against an existing table fails loudly rather than
   *  truncating or padding. */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${TABLE} (
            entry_id   TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            project_id TEXT,
            namespace  TEXT NOT NULL,
            embedding  vector(${this.dim}) NOT NULL,
            payload    JSONB NOT NULL DEFAULT '{}'
          )`);
        const { rows } = await this.pool.query(
          `SELECT atttypmod AS dim FROM pg_attribute
           WHERE attrelid = '${TABLE}'::regclass AND attname = 'embedding'`,
        );
        const existing = Number(rows[0]?.dim);
        if (existing && existing !== this.dim) {
          throw new Error(
            `${TABLE}.embedding is vector(${existing}) but NOVAMEM_COLD_VECTOR_SIZE=${this.dim} — ` +
            `refusing to mix dimensionalities; migrate or re-embed first`,
          );
        }
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_vectors_hnsw ON ${TABLE}
           USING hnsw (embedding vector_cosine_ops)`,
        );
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_vectors_scope ON ${TABLE} (user_id, project_id, namespace)`,
        );
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_vectors_project ON ${TABLE} (project_id)
           WHERE project_id IS NOT NULL`,
        );
      })();
    }
    return this.ready;
  }

  /** Same scope rule as the Qdrant store's collection naming: a
   *  project-scoped entry lives under its project (user intentionally
   *  not part of the key — project members share the space); a user
   *  entry lives under (user, no project). */
  private scopeWhere(userId: string, projectId: string | null): { clause: string; params: unknown[] } {
    return projectId === null
      ? { clause: "user_id = $1 AND project_id IS NULL", params: [userId] }
      : { clause: "project_id = $1", params: [projectId] };
  }

  async upsert(args: {
    userId: string;
    projectId?: string | null;
    id: string;
    namespace: string;
    embedding: number[];
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.ensureReady();
    const projectId = args.projectId ?? null;
    await this.pool.query(
      `INSERT INTO ${TABLE} (entry_id, user_id, project_id, namespace, embedding, payload)
       VALUES ($1, $2, $3, $4, $5::vector, $6)
       ON CONFLICT (entry_id) DO UPDATE SET
         user_id = EXCLUDED.user_id, project_id = EXCLUDED.project_id,
         namespace = EXCLUDED.namespace, embedding = EXCLUDED.embedding,
         payload = EXCLUDED.payload`,
      [args.id, args.userId, projectId, args.namespace,
       toVectorLiteral(args.embedding),
       { ...args.payload, entryId: args.id, userId: args.userId, projectId }],
    );
  }

  async search(args: {
    userId: string;
    projectId?: string | null;
    namespace: string;
    embedding: number[];
    k: number;
  }): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    await this.ensureReady();
    const scope = this.scopeWhere(args.userId, args.projectId ?? null);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        // pgvector >= 0.8: keep walking the graph until enough rows
        // survive the WHERE filter. Older versions: no such GUC — ignore.
        await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
      } catch {
        /* pre-0.8 pgvector */
      }
      const { rows } = await client.query(
        `SELECT entry_id, payload, 1 - (embedding <=> $${scope.params.length + 1}::vector) AS score
         FROM ${TABLE}
         WHERE ${scope.clause} AND namespace = $${scope.params.length + 2}
         ORDER BY embedding <=> $${scope.params.length + 1}::vector
         LIMIT $${scope.params.length + 3}`,
        [...scope.params, toVectorLiteral(args.embedding), args.namespace, args.k],
      );
      await client.query("COMMIT");
      return rows.map((r) => ({
        id: r.entry_id as string,
        // Same clip as the Qdrant store: a negative cosine means
        // "points apart" and must not contribute negative weight.
        score: Math.max(0, Number(r.score)),
        payload: (r.payload ?? {}) as Record<string, unknown>,
      }));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async existingIds(
    entries: Array<{ id: string; userId: string; projectId: string | null; namespace: string }>,
  ): Promise<Set<string>> {
    await this.ensureReady();
    if (entries.length === 0) return new Set();
    // Scope discipline applies to reads-by-id too: an id existing under a
    // DIFFERENT tenant/namespace must not count, both for correctness
    // (backfillMissingVector would skip a needed re-embed) and to deny
    // cross-tenant existence probing of the shared table. One grouped
    // query via a VALUES join rather than N round-trips.
    const values: string[] = [];
    const params: unknown[] = [];
    entries.forEach((e, i) => {
      const b = i * 4;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
      params.push(e.id, e.userId, e.projectId, e.namespace);
    });
    const { rows } = await this.pool.query(
      `SELECT v.id FROM (VALUES ${values.join(",")}) AS v(id, user_id, project_id, namespace)
       JOIN ${TABLE} t ON t.entry_id = v.id
        AND t.namespace = v.namespace
        AND ((v.project_id IS NULL AND t.user_id = v.user_id AND t.project_id IS NULL)
          OR (v.project_id IS NOT NULL AND t.project_id = v.project_id))`,
      params,
    );
    return new Set(rows.map((r) => r.id as string));
  }

  async delete(
    userId: string,
    namespace: string,
    id: string,
    projectId: string | null = null,
  ): Promise<void> {
    await this.ensureReady();
    const scope = this.scopeWhere(userId, projectId);
    // Namespace is part of the scope here exactly as it is in search():
    // knowing an id must not be enough to delete across shelves.
    await this.pool.query(
      `DELETE FROM ${TABLE}
       WHERE entry_id = $${scope.params.length + 1}
         AND namespace = $${scope.params.length + 2}
         AND ${scope.clause}`,
      [...scope.params, id, namespace],
    );
  }

  async deleteAllForProject(projectId: string): Promise<string[]> {
    await this.ensureReady();
    const r = await this.pool.query(
      `DELETE FROM ${TABLE} WHERE project_id = $1`,
      [projectId],
    );
    // The Qdrant store returns dropped collection names; the pgvector
    // equivalent is one shared table, so report the row count in the
    // same string[] shape for wire compatibility.
    return [`${TABLE}: ${r.rowCount ?? 0} vectors removed for project ${projectId}`];
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureReady();
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
