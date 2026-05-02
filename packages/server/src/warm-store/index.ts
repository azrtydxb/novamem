/**
 * Warm-store driver. Postgres-only for now; SQLite adapter is a follow-up.
 *
 * The store owns the SQL-level concerns (drizzle queries, FTS triggers). The
 * engine layer composes these calls into the public API surface.
 */

import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { ulid } from "ulid";

import * as schema from "./schema.js";

export type WarmDB = NodePgDatabase<typeof schema>;

export interface WarmStoreConfig {
  url: string;
}

export class WarmStore {
  readonly db: WarmDB;
  private readonly pool: Pool;

  constructor(cfg: WarmStoreConfig) {
    this.pool = new Pool({ connectionString: cfg.url });
    this.db = drizzle(this.pool, { schema });
  }

  async initialize(): Promise<void> {
    // Idempotent schema creation. In production we'd use drizzle-kit migrations;
    // for v0 we keep CREATE IF NOT EXISTS inline so docker-compose just works.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS memory_entries (
        id text PRIMARY KEY,
        content text NOT NULL,
        namespace text NOT NULL DEFAULT 'default',
        source text NOT NULL DEFAULT 'manual',
        agent_name text,
        metadata jsonb DEFAULT '{}'::jsonb,
        cold boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_entries_namespace ON memory_entries(namespace)`,
      `CREATE INDEX IF NOT EXISTS idx_entries_agent ON memory_entries(agent_name)`,
      `CREATE INDEX IF NOT EXISTS idx_entries_cold ON memory_entries(cold)`,
      `CREATE TABLE IF NOT EXISTS memory_access (
        entry_id text PRIMARY KEY,
        hits int NOT NULL DEFAULT 1,
        last_accessed timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_access_last ON memory_access(last_accessed)`,
      `CREATE TABLE IF NOT EXISTS memory_relations (
        from_id text NOT NULL,
        to_id text NOT NULL,
        relation text NOT NULL DEFAULT 'co_occurs',
        strength real NOT NULL DEFAULT 1.0,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (from_id, to_id, relation)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_id)`,
      `CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_id)`,
      `CREATE TABLE IF NOT EXISTS web_cache (
        id text PRIMARY KEY,
        query_hash text NOT NULL,
        query text NOT NULL,
        payload jsonb NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_webcache_hash ON web_cache(query_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_webcache_expires ON web_cache(expires_at)`,
      `CREATE TABLE IF NOT EXISTS memory_fts (
        id serial PRIMARY KEY,
        entry_id text NOT NULL,
        content text NOT NULL,
        namespace text NOT NULL DEFAULT 'default',
        tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      )`,
      `CREATE INDEX IF NOT EXISTS idx_fts_tsv ON memory_fts USING gin(tsv)`,
      `CREATE INDEX IF NOT EXISTS idx_fts_namespace ON memory_fts(namespace)`,
      `CREATE INDEX IF NOT EXISTS idx_fts_entry ON memory_fts(entry_id)`,
      `CREATE TABLE IF NOT EXISTS decay_runs (
        id serial PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        demoted int NOT NULL DEFAULT 0,
        promoted int NOT NULL DEFAULT 0,
        effective_days real
      )`,
    ];
    for (const stmt of ddl) {
      await this.pool.query(stmt);
    }
  }

  async insertEntry(args: {
    content: string;
    namespace: string;
    source: string;
    agentName?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = ulid();
    await this.db.insert(schema.memoryEntries).values({
      id,
      content: args.content,
      namespace: args.namespace,
      source: args.source,
      agentName: args.agentName ?? null,
      metadata: args.metadata ?? {},
    });
    await this.db.insert(schema.memoryFts).values({
      entryId: id,
      content: args.content,
      namespace: args.namespace,
    });
    await this.db.insert(schema.memoryAccess).values({ entryId: id });
    return id;
  }

  /** Full-text keyword search via Postgres tsvector. */
  async ftsSearch(args: {
    query: string;
    namespace: string;
    k: number;
  }): Promise<Array<{ id: string; score: number }>> {
    const rows = await this.pool.query<{ entry_id: string; score: number }>(
      `SELECT entry_id,
              ts_rank(tsv, plainto_tsquery('english', $1)) AS score
         FROM memory_fts
        WHERE namespace = $2
          AND tsv @@ plainto_tsquery('english', $1)
        ORDER BY score DESC
        LIMIT $3`,
      [args.query, args.namespace, args.k],
    );
    return rows.rows.map((r) => ({ id: r.entry_id, score: Number(r.score) }));
  }

  async getEntry(id: string) {
    const rows = await this.db.select().from(schema.memoryEntries).where(eq(schema.memoryEntries.id, id));
    return rows[0];
  }

  async bumpHits(id: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_access (entry_id, hits, last_accessed)
       VALUES ($1, 1, now())
       ON CONFLICT (entry_id) DO UPDATE
         SET hits = memory_access.hits + 1, last_accessed = now()`,
      [id],
    );
  }

  async listColdCandidates(effectiveDays: number, limit = 1000) {
    // Demote warm → cold when last_accessed is older than effective lifespan.
    return this.pool.query<{ id: string; hits: number }>(
      `SELECT e.id, a.hits
         FROM memory_entries e
         JOIN memory_access a ON a.entry_id = e.id
        WHERE e.cold = false
          AND a.last_accessed < now() - ($1 || ' days')::interval
        ORDER BY a.last_accessed ASC
        LIMIT $2`,
      [effectiveDays, limit],
    );
  }

  async markCold(id: string, cold: boolean): Promise<void> {
    await this.db
      .update(schema.memoryEntries)
      .set({ cold, updatedAt: new Date() })
      .where(eq(schema.memoryEntries.id, id));
  }

  async stats() {
    const r = await this.pool.query<{ namespace: string; cold: boolean; count: string }>(
      `SELECT namespace, cold, COUNT(*)::text AS count
         FROM memory_entries
        GROUP BY namespace, cold`,
    );
    const last = await this.pool.query<{ finished_at: Date | null }>(
      `SELECT finished_at FROM decay_runs ORDER BY id DESC LIMIT 1`,
    );
    return { rows: r.rows, lastDecayAt: last.rows[0]?.finished_at ?? null };
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // Re-export for higher layers needing direct drizzle access.
  get schema() {
    return schema;
  }

  // Helpers used by hybrid search and engine.
  asc = asc;
  desc = desc;
  eq = eq;
  and = and;
  sql = sql;
}
