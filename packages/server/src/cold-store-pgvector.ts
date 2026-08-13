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
/** Hash-partition count. Fixed after first creation (changing it means a
 *  table rebuild via the migration tool); 32 keeps each partition's HNSW
 *  graph small through the multi-million-vector range. */
const PARTITIONS = 32;

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

  /** Idempotent DDL, run once per process on first use.
   *
   *  The table is HASH-PARTITIONED on (`scope`, `namespace`) — scope is
   *  `u:<user>` / `p:<project>` — so each partition carries its own
   *  small HNSW graph. Namespace is part of the key deliberately: a
   *  deployment dominated by ONE tenant (the bench: a single shared
   *  bearer user) would otherwise pack every vector into one partition
   *  and get zero benefit — measured exactly that way before this key
   *  was widened. Every engine query filters on both columns, so
   *  pruning still hits a single partition. Two scaling properties follow:
   *  inserts pay the small-graph walk forever instead of degrading with
   *  global table size (measured on the bench sync: ~5k inserts/min at
   *  260k rows on one big graph), and every query the engine issues
   *  filters on exactly this scope, so partition pruning gives the ANN
   *  search a per-tenant-bucket graph — Qdrant's per-collection
   *  isolation model, rebuilt inside Postgres.
   *
   *  Dimensionality comes from config; a mismatch against an existing
   *  table fails loudly rather than truncating or padding. */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${TABLE} (
            entry_id   TEXT NOT NULL,
            user_id    TEXT NOT NULL,
            project_id TEXT,
            namespace  TEXT NOT NULL,
            scope      TEXT NOT NULL,
            embedding  vector(${this.dim}) NOT NULL,
            payload    JSONB NOT NULL DEFAULT '{}',
            PRIMARY KEY (entry_id, scope, namespace)
          ) PARTITION BY HASH (scope, namespace)`);
        for (let i = 0; i < PARTITIONS; i++) {
          await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${TABLE}_p${i} PARTITION OF ${TABLE}
             FOR VALUES WITH (MODULUS ${PARTITIONS}, REMAINDER ${i})`);
        }
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
        // A table created by an earlier build (PK/partition key without
        // namespace) fails upserts with an opaque ON CONFLICT error —
        // detect it at startup and say what to actually do.
        // string_agg, not array_agg: node-pg hands back name[] as the
        // literal "{a,b,c}" string, and the guard itself threw TypeError
        // on it — which read as "cold store down" instead of the
        // intended migration message.
        const pk = await this.pool.query(
          `SELECT string_agg(a.attname, ',' ORDER BY x.n) AS cols
           FROM pg_index i
           JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, n) ON true
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
           WHERE i.indrelid = '${TABLE}'::regclass AND i.indisprimary`,
        );
        const cols: string = pk.rows[0]?.cols ?? "";
        if (cols && cols !== "entry_id,scope,namespace") {
          throw new Error(
            `${TABLE} has primary key (${cols.split(",").join(", ")}) from an older build; ` +
            `this version requires (entry_id, scope, namespace). ` +
            `Rebuild the table: DROP TABLE ${TABLE}, restart to recreate, then re-run ` +
            `scripts/sync-qdrant-to-pgvector.mjs (or re-embed).`,
          );
        }
        // Partitioned parents can't carry an HNSW index; each partition
        // gets its own (that is the point).
        for (let i = 0; i < PARTITIONS; i++) {
          await this.pool.query(
            `CREATE INDEX IF NOT EXISTS idx_vectors_hnsw_p${i} ON ${TABLE}_p${i}
             USING hnsw (embedding vector_cosine_ops)`);
        }
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_vectors_scope ON ${TABLE} (scope, namespace)`,
        );
      })().catch((err) => {
        // A failed attempt (e.g. Postgres briefly down at boot) must not
        // be cached forever: with a sticky rejected promise every later
        // ping() fails and the pod can never become ready without a
        // process restart — observed live on the bench during a postgres
        // crashloop. Clear the memo so the next call retries.
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  /** Same scope rule as the Qdrant store's collection naming: a
   *  project-scoped entry lives under its project (user intentionally
   *  not part of the key — project members share the space); a user
   *  entry lives under (user, no project). */
  /** The partition key. Matching on `scope` (not user/project columns)
   *  is what lets the planner prune to a single partition. */
  private scopeOf(userId: string, projectId: string | null): string {
    return projectId === null ? `u:${userId}` : `p:${projectId}`;
  }

  private scopeWhere(userId: string, projectId: string | null): { clause: string; params: unknown[] } {
    return { clause: "scope = $1", params: [this.scopeOf(userId, projectId)] };
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
      `INSERT INTO ${TABLE} (entry_id, user_id, project_id, namespace, scope, embedding, payload)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
       ON CONFLICT (entry_id, scope, namespace) DO UPDATE SET
         user_id = EXCLUDED.user_id, project_id = EXCLUDED.project_id,
         namespace = EXCLUDED.namespace, embedding = EXCLUDED.embedding,
         payload = EXCLUDED.payload`,
      [args.id, args.userId, projectId, args.namespace,
       this.scopeOf(args.userId, projectId),
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
      const b = i * 3;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
      params.push(e.id, this.scopeOf(e.userId, e.projectId), e.namespace);
    });
    const { rows } = await this.pool.query(
      `SELECT v.id FROM (VALUES ${values.join(",")}) AS v(id, scope, namespace)
       JOIN ${TABLE} t ON t.entry_id = v.id
        AND t.scope = v.scope
        AND t.namespace = v.namespace`,
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

  /** Remove every user-wide vector for a user. Project-scoped vectors
   *  are removed by deleteAllForProject when their project dies. */
  async deleteAllForUser(userId: string): Promise<string[]> {
    await this.ensureReady();
    const r = await this.pool.query(
      `DELETE FROM ${TABLE} WHERE user_id = $1`,
      [userId],
    );
    return [`${TABLE}: ${r.rowCount ?? 0} vectors removed for user ${userId}`];
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
