/**
 * Warm-store driver. Owns the Postgres pool and runs the SQL for the memory
 * primitives. The engine layer composes these calls into the public API
 * surface.
 */

import { createHash, randomBytes } from "node:crypto";

import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { ulid } from "ulid";

import * as schema from "./schema.js";

/** Plaintext bearer token format. 32 random bytes → ~43 base64url chars,
 *  prefixed `nm_` so leaks are recognizable in logs / git history. */
function generateBearerToken(): string {
  return "nm_" + randomBytes(32).toString("base64url");
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export const SYSTEM_USER = "public";

export type WarmDB = NodePgDatabase<typeof schema>;

export interface WarmStoreConfig {
  url: string;
}

export class WarmStore {
  readonly db: WarmDB;
  /** Direct Postgres pool. Public so the engine can run ad-hoc SQL (e.g.
   *  `recent()` time-window queries) without parking another driver in
   *  this layer. */
  readonly pool: Pool;

  constructor(cfg: WarmStoreConfig) {
    // P1-P4: bound the pg connection pool so a load spike can't exhaust
    // Postgres connections silently. Default max=20 is well below typical
    // Postgres `max_connections` of 100 even when several server replicas
    // share a database. Operators can override via NOVAMEM_PG_POOL_MAX.
    const poolMax = Number(process.env.NOVAMEM_PG_POOL_MAX ?? "20");
    this.pool = new Pool({
      connectionString: cfg.url,
      max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.db = drizzle(this.pool, { schema });
  }

  async initialize(): Promise<void> {
    // Idempotent schema creation. In production we'd use drizzle-kit migrations;
    // for v0 we keep CREATE IF NOT EXISTS inline so docker-compose just works.
    // ALTERs are also idempotent (`ADD COLUMN IF NOT EXISTS`) so existing
    // single-user installs upgrade in place — pre-user rows backfill to
    // `public` via the column DEFAULT.
    const ddl = [
      // Users are the only first-class memory owner — no separate
      // owner table. The synthetic id "public" is the implicit owner
      // for `auth.mode = none|bearer` deployments.
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        username text NOT NULL,
        password_hash text NOT NULL,
        role text NOT NULL DEFAULT 'user',
        created_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz,
        password_changed_at timestamptz
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users(username)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz`,
      `INSERT INTO users (id, username, password_hash, role)
         VALUES ('public', 'public', 'unused', 'user')
         ON CONFLICT (id) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS user_tokens (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id)`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS projects (
        id text PRIMARY KEY,
        name text NOT NULL,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_projects_owner_user ON projects(owner_user_id)`,
      `CREATE TABLE IF NOT EXISTS project_members (
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member',
        joined_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`,
      // NB: project_id ALTERs for memory_entries / memory_fts / memory_relations /
      // cold_orphans are issued AFTER those tables are created — see below.
      `CREATE TABLE IF NOT EXISTS memory_entries (
        id text PRIMARY KEY,
        user_id text NOT NULL DEFAULT 'public',
        content text NOT NULL,
        namespace text NOT NULL DEFAULT 'default',
        source text NOT NULL DEFAULT 'manual',
        agent_name text,
        metadata jsonb DEFAULT '{}'::jsonb,
        cold boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      // Upgrade path for installs that pre-date multi-tenancy:
      `ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'public'`,
      `CREATE INDEX IF NOT EXISTS idx_entries_user ON memory_entries(user_id)`,
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
        user_id text NOT NULL DEFAULT 'public',
        from_id text NOT NULL,
        to_id text NOT NULL,
        relation text NOT NULL DEFAULT 'co_occurs',
        strength real NOT NULL DEFAULT 1.0,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (from_id, to_id, relation)
      )`,
      `ALTER TABLE memory_relations ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'public'`,
      `CREATE INDEX IF NOT EXISTS idx_relations_user ON memory_relations(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_id)`,
      `CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_id)`,
      `CREATE TABLE IF NOT EXISTS memory_fts (
        id serial PRIMARY KEY,
        entry_id text NOT NULL,
        user_id text NOT NULL DEFAULT 'public',
        content text NOT NULL,
        namespace text NOT NULL DEFAULT 'default',
        tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      )`,
      `ALTER TABLE memory_fts ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'public'`,
      `CREATE INDEX IF NOT EXISTS idx_fts_tsv ON memory_fts USING gin(tsv)`,
      `CREATE INDEX IF NOT EXISTS idx_fts_user ON memory_fts(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_fts_namespace ON memory_fts(namespace)`,
      `CREATE INDEX IF NOT EXISTS idx_fts_entry ON memory_fts(entry_id)`,
      `CREATE TABLE IF NOT EXISTS cold_orphans (
        id text PRIMARY KEY,
        user_id text NOT NULL DEFAULT 'public',
        namespace text NOT NULL,
        attempts int NOT NULL DEFAULT 0,
        last_error text,
        first_seen timestamptz NOT NULL DEFAULT now(),
        last_attempt_at timestamptz
      )`,
      `ALTER TABLE cold_orphans ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'public'`,
      `CREATE INDEX IF NOT EXISTS idx_orphans_attempts ON cold_orphans(attempts)`,
      `CREATE TABLE IF NOT EXISTS decay_runs (
        id serial PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        demoted int NOT NULL DEFAULT 0,
        promoted int NOT NULL DEFAULT 0,
        effective_days real
      )`,
      // ─── Project-id retrofits (after all base tables exist) ─────────
      // These ALTERs come last because they reference tables created above.
      // The original placement (before the CREATEs) crashed on a fresh DB
      // — see review finding P1-A7. Issued idempotently.
      `ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS project_id text`,
      `CREATE INDEX IF NOT EXISTS idx_entries_project ON memory_entries(project_id)`,
      `ALTER TABLE memory_relations ADD COLUMN IF NOT EXISTS project_id text`,
      `CREATE INDEX IF NOT EXISTS idx_relations_project ON memory_relations(project_id)`,
      `ALTER TABLE memory_fts ADD COLUMN IF NOT EXISTS project_id text`,
      `CREATE INDEX IF NOT EXISTS idx_fts_project ON memory_fts(project_id)`,
      `ALTER TABLE cold_orphans ADD COLUMN IF NOT EXISTS project_id text`,
      // ─── Audit log of admin actions (P1-S6) ─────────────────────────
      `CREATE TABLE IF NOT EXISTS admin_audit_log (
        id serial PRIMARY KEY,
        ts timestamptz NOT NULL DEFAULT now(),
        actor_user_id text,
        actor_label text NOT NULL,
        action text NOT NULL,
        target text,
        metadata jsonb,
        request_ip text
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts ON admin_audit_log(ts DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_actor ON admin_audit_log(actor_user_id)`,
      // ─── Better Auth tables (Phase 1: scaffolded alongside) ──────────
      // The dashboard's control plane is migrating to Better Auth. These
      // tables hold its users/sessions/accounts; the existing `users`/
      // `sessions` tables stay live until the cutover. Identifiers are
      // double-quoted because Better Auth uses camelCase column names
      // and the singular `user` is a reserved word in some contexts.
      `CREATE TABLE IF NOT EXISTS "user" (
        id text PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL UNIQUE,
        "emailVerified" boolean NOT NULL DEFAULT false,
        image text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        role text,
        banned boolean,
        "banReason" text,
        "banExpires" timestamptz
      )`,
      `CREATE TABLE IF NOT EXISTS "session" (
        id text PRIMARY KEY,
        "expiresAt" timestamptz NOT NULL,
        token text NOT NULL UNIQUE,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "ipAddress" text,
        "userAgent" text,
        "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        "impersonatedBy" text
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ba_session_user ON "session"("userId")`,
      `CREATE TABLE IF NOT EXISTS "account" (
        id text PRIMARY KEY,
        "accountId" text NOT NULL,
        "providerId" text NOT NULL,
        "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        "accessToken" text,
        "refreshToken" text,
        "idToken" text,
        "accessTokenExpiresAt" timestamptz,
        "refreshTokenExpiresAt" timestamptz,
        scope text,
        password text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ba_account_user ON "account"("userId")`,
      `CREATE TABLE IF NOT EXISTS "verification" (
        id text PRIMARY KEY,
        identifier text NOT NULL,
        value text NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ba_verification_identifier ON "verification"(identifier)`,
      `CREATE TABLE IF NOT EXISTS "jwks" (
        id text PRIMARY KEY,
        "publicKey" text NOT NULL,
        "privateKey" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`,
      // ─── Performance: composite indexes flagged in review (P1-P2) ───
      `CREATE INDEX IF NOT EXISTS idx_entries_user_cold ON memory_entries(user_id, cold)`,
      `CREATE INDEX IF NOT EXISTS idx_orphans_attempt_lastattempt ON cold_orphans(attempts, last_attempt_at)`,
      // ─── 24h persistent throughput (1-min buckets) ────────────────────
      // Each row: counts observed in the (sampled_at, sampled_at + 1min)
      // window for the given user. Bucket boundary is sampled_at floored
      // to the minute; the unique constraint stops a double-flush from
      // producing two rows for the same minute.
      `CREATE TABLE IF NOT EXISTS metrics_samples (
        user_id text NOT NULL,
        sampled_at timestamptz NOT NULL,
        queries int NOT NULL DEFAULT 0,
        remembers int NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, sampled_at)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_metrics_samples_at ON metrics_samples(sampled_at DESC)`,
    ];
    for (const stmt of ddl) {
      await this.pool.query(stmt);
    }
  }

  // ─── Tokens ───────────────────────────────────────────────────────────

  /** Mint a new bearer token for a user. Returns the **plaintext** token —
   *  the caller is responsible for getting it to their device; the server
   *  keeps only the sha256 hash. The bearer grants access to everything
   *  the owning user can reach (global memory + every project the user
   *  is a member of); there is no per-token project scope. Returns null
   *  if the user doesn't exist. */
  async createUserToken(
    userId: string,
    label?: string,
  ): Promise<{ token: string; userId: string; createdAt: Date } | null> {
    const exists = await this.pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    if (exists.rowCount === 0) return null;
    const token = generateBearerToken();
    const tokenHash = hashToken(token);
    const r = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO user_tokens (token_hash, user_id, label)
       VALUES ($1, $2, $3)
       RETURNING created_at`,
      [tokenHash, userId, label ?? null],
    );
    return { token, userId, createdAt: r.rows[0]!.created_at };
  }

  /** Resolve a plaintext bearer token to its user id. Touches `last_used_at`
   *  on success so dormant tokens are visible to operators. Returns null on
   *  unknown or revoked tokens — never throw, the auth hook decides what 4xx
   *  to send. */
  async resolveUserToken(
    plaintext: string,
  ): Promise<{
    userId: string;
    tokenHash: string;
    label: string | null;
  } | null> {
    if (!plaintext) return null;
    const tokenHash = hashToken(plaintext);
    const r = await this.pool.query<{
      user_id: string;
      label: string | null;
    }>(
      `UPDATE user_tokens SET last_used_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING user_id, label`,
      [tokenHash],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { userId: row.user_id, tokenHash, label: row.label };
  }

  async revokeUserToken(plaintext: string): Promise<boolean> {
    const tokenHash = hashToken(plaintext);
    const r = await this.pool.query(
      `UPDATE user_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Revoke a token by sha256 hash (soft — keeps the row with revoked_at
   *  stamped). Used by admin tooling that wants a tombstone for audit. */
  async revokeUserTokenByHash(userId: string, tokenHash: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE user_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [tokenHash, userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Hard-delete a token by sha256 hash. Used by the user dashboard's
   *  delete-token action so the row disappears from the list outright —
   *  the soft revoke would leave dead entries cluttering the table. */
  async deleteUserTokenByHash(userId: string, tokenHash: string): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM user_tokens WHERE token_hash = $1 AND user_id = $2`,
      [tokenHash, userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Activity feed for the user dashboard "Today" page. Returns the
   *  last N events of mixed kinds (`remember` + `token` + project member
   *  joins) ranked by timestamp. User-scoped. Auth audit log entries
   *  for this user are also included so the user can see their own
   *  password resets / role changes / etc. */
  async listRecentActivity(
    userId: string,
    limit = 50,
  ): Promise<
    Array<{
      kind: "remember" | "token" | "project" | "audit";
      at: string;
      text: string;
      project: string | null;
    }>
  > {
    const lim = Math.max(1, Math.min(200, limit));
    const r = await this.pool.query<{
      kind: string;
      at: Date;
      text: string;
      project: string | null;
    }>(
      `SELECT kind, at, text, project FROM (
         SELECT 'remember'::text AS kind, created_at AS at,
                left(content, 160) AS text, project_id AS project
           FROM memory_entries WHERE user_id = $1
         UNION ALL
         SELECT 'token'::text AS kind, created_at AS at,
                'Minted token: ' || COALESCE(label, '(no label)') AS text,
                project_id AS project
           FROM user_tokens
          WHERE user_id = $1 AND revoked_at IS NULL
         UNION ALL
         SELECT 'project'::text AS kind, joined_at AS at,
                'Joined project: ' || project_id AS text,
                project_id AS project
           FROM project_members WHERE user_id = $1
         UNION ALL
         SELECT 'audit'::text AS kind, ts AS at,
                action || ' ' || COALESCE(target, '') AS text,
                NULL::text AS project
           FROM admin_audit_log WHERE actor_user_id = $1
       ) src
       ORDER BY at DESC
       LIMIT $2`,
      [userId, lim],
    );
    return r.rows.map((row) => ({
      kind: row.kind as "remember" | "token" | "project" | "audit",
      at: row.at.toISOString(),
      text: row.text,
      project: row.project,
    }));
  }

  /** Tokens belonging to a specific user — used to scope per-token
   *  metrics to "my own tokens" on the user dashboard. Excludes revoked. */
  async listTokensCreatedByUser(
    userId: string,
  ): Promise<Array<{ tokenHash: string; label: string | null; userId: string }>> {
    const r = await this.pool.query<{
      token_hash: string;
      label: string | null;
      user_id: string;
    }>(
      `SELECT token_hash, label, user_id FROM user_tokens
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at ASC`,
      [userId],
    );
    return r.rows.map((row) => ({
      tokenHash: row.token_hash,
      label: row.label,
      userId: row.user_id,
    }));
  }

  async listUserTokens(
    userId: string,
  ): Promise<
    Array<{
      tokenHash: string;
      label: string | null;
      createdAt: Date;
      lastUsedAt: Date | null;
      revoked: boolean;
    }>
  > {
    const r = await this.pool.query<{
      token_hash: string;
      label: string | null;
      created_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT token_hash, label, created_at, last_used_at, revoked_at FROM user_tokens
        WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    return r.rows.map((row) => ({
      tokenHash: row.token_hash,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revoked: row.revoked_at !== null,
    }));
  }

  /** Rotate a user's bearer token: revoke the current plaintext and mint a
   *  new one for the same user. Returns the new plaintext (shown once) or
   *  null when the supplied plaintext is unknown / already revoked. Used by
   *  the user-facing `POST /v1/me/rotate-token` endpoint — users don't
   *  have a dashboard, this is their only self-service operation. */
  async rotateUserToken(
    plaintext: string,
  ): Promise<{ token: string; userId: string; createdAt: Date } | null> {
    const oldHash = hashToken(plaintext);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ user_id: string }>(
        `UPDATE user_tokens SET revoked_at = now()
          WHERE token_hash = $1 AND revoked_at IS NULL
          RETURNING user_id`,
        [oldHash],
      );
      const userId = r.rows[0]?.user_id;
      if (!userId) {
        await client.query("ROLLBACK");
        return null;
      }
      const token = generateBearerToken();
      const hash = hashToken(token);
      const ins = await client.query<{ created_at: Date }>(
        `INSERT INTO user_tokens (token_hash, user_id, label) VALUES ($1, $2, $3)
         RETURNING created_at`,
        [hash, userId, "rotated"],
      );
      await client.query("COMMIT");
      return { token, userId, createdAt: ins.rows[0]!.created_at };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Delete a user and every memory row owned by them. Caller must purge
   *  cold collections and graph nodes separately — those live in
   *  different processes. Returns false for the synthetic `public` user
   *  (would orphan every legacy row) or an unknown id. */
  async deleteUserAndMemory(id: string): Promise<{ deleted: boolean; entriesRemoved: number }> {
    if (id === SYSTEM_USER) return { deleted: false, entriesRemoved: 0 };
    const exists = await this.pool.query("SELECT 1 FROM users WHERE id = $1", [id]);
    if (exists.rowCount === 0) return { deleted: false, entriesRemoved: 0 };

    const client = await this.pool.connect();
    let entriesRemoved = 0;
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM memory_access WHERE entry_id IN (SELECT id FROM memory_entries WHERE user_id = $1)`,
        [id],
      );
      await client.query("DELETE FROM memory_fts WHERE user_id = $1", [id]);
      await client.query("DELETE FROM memory_relations WHERE user_id = $1", [id]);
      const del = await client.query("DELETE FROM memory_entries WHERE user_id = $1", [id]);
      entriesRemoved = del.rowCount ?? 0;
      await client.query("DELETE FROM cold_orphans WHERE user_id = $1", [id]);
      // user_tokens, sessions, projects cascade via FK ON DELETE CASCADE.
      await client.query("DELETE FROM users WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { deleted: true, entriesRemoved };
  }

  // ─── Users ────────────────────────────────────────────────────────────

  async createUser(args: {
    username: string;
    passwordHash: string;
    role: "admin" | "user";
  }): Promise<{ id: string; username: string; role: string; createdAt: Date; passwordChangedAt: Date | null }> {
    const id = ulid();
    const r = await this.pool.query<{ created_at: Date; password_changed_at: Date | null }>(
      `INSERT INTO users (id, username, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING created_at, password_changed_at`,
      [id, args.username, args.passwordHash, args.role],
    );
    return {
      id,
      username: args.username,
      role: args.role,
      createdAt: r.rows[0]!.created_at,
      passwordChangedAt: r.rows[0]!.password_changed_at,
    };
  }

  async findUserByUsername(username: string): Promise<{
    id: string;
    username: string;
    passwordHash: string;
    role: string;
    passwordChangedAt: Date | null;
  } | null> {
    const r = await this.pool.query<{
      id: string;
      username: string;
      password_hash: string;
      role: string;
      password_changed_at: Date | null;
    }>(`SELECT id, username, password_hash, role, password_changed_at FROM users WHERE username = $1`, [username]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      passwordChangedAt: row.password_changed_at,
    };
  }

  async findUserById(id: string): Promise<{
    id: string;
    username: string;
    role: string;
  } | null> {
    const r = await this.pool.query<{
      id: string;
      username: string;
      role: string;
    }>(`SELECT id, username, role FROM users WHERE id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.id, username: row.username, role: row.role };
  }

  async listUsers(): Promise<
    Array<{
      id: string;
      username: string;
      role: string;
      createdAt: Date;
      lastLoginAt: Date | null;
      passwordChangedAt: Date | null;
    }>
  > {
    const r = await this.pool.query<{
      id: string;
      username: string;
      role: string;
      created_at: Date;
      last_login_at: Date | null;
      password_changed_at: Date | null;
    }>(`SELECT id, username, role, created_at, last_login_at, password_changed_at FROM users ORDER BY created_at ASC`);
    return r.rows.map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      passwordChangedAt: row.password_changed_at,
    }));
  }

  async deleteUser(id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM users WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async patchUserPassword(id: string, passwordHash: string, changedAt: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE users SET password_hash = $1, password_changed_at = $2 WHERE id = $3`,
      [passwordHash, changedAt, id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async setUserRole(id: string, role: "admin" | "user"): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE users SET role = $1 WHERE id = $2`,
      [role, id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async countAdmins(): Promise<number> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin'`,
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  // ─── Sessions ─────────────────────────────────────────────────────────

  async createSession(userId: string, ttlMs: number): Promise<{ token: string; expiresAt: Date }> {
    const token = "ns_" + randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash, userId, expiresAt],
    );
    await this.pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
    return { token, expiresAt };
  }

  async resolveSession(plaintext: string): Promise<{
    user: { id: string; username: string; role: string };
  } | null> {
    if (!plaintext) return null;
    const tokenHash = hashToken(plaintext);
    const r = await this.pool.query<{
      user_id: string;
      username: string;
      role: string;
    }>(
      `UPDATE sessions SET last_seen_at = now()
        WHERE token_hash = $1 AND expires_at > now()
        RETURNING user_id,
                  (SELECT username FROM users u WHERE u.id = sessions.user_id) AS username,
                  (SELECT role FROM users u WHERE u.id = sessions.user_id) AS role`,
      [tokenHash],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      user: {
        id: row.user_id,
        username: row.username,
        role: row.role,
      },
    };
  }

  async revokeSession(plaintext: string): Promise<boolean> {
    if (!plaintext) return false;
    const tokenHash = hashToken(plaintext);
    const r = await this.pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
    return (r.rowCount ?? 0) > 0;
  }

  // ─── Audit log (P1-S6) ────────────────────────────────────────────────

  async writeAudit(entry: {
    actorUserId?: string | null;
    actorLabel: string;
    action: string;
    target?: string | null;
    metadata?: Record<string, unknown>;
    requestIp?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_audit_log (actor_user_id, actor_label, action, target, metadata, request_ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.actorUserId ?? null,
        entry.actorLabel,
        entry.action,
        entry.target ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.requestIp ?? null,
      ],
    );
  }

  async listAuditLog(opts: { limit?: number } = {}): Promise<
    Array<{
      id: number;
      ts: Date;
      actorUserId: string | null;
      actorLabel: string;
      action: string;
      target: string | null;
      metadata: Record<string, unknown> | null;
      requestIp: string | null;
    }>
  > {
    const r = await this.pool.query<{
      id: number;
      ts: Date;
      actor_user_id: string | null;
      actor_label: string;
      action: string;
      target: string | null;
      metadata: Record<string, unknown> | null;
      request_ip: string | null;
    }>(
      `SELECT id, ts, actor_user_id, actor_label, action, target, metadata, request_ip
         FROM admin_audit_log ORDER BY id DESC LIMIT $1`,
      [opts.limit ?? 200],
    );
    return r.rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      actorUserId: row.actor_user_id,
      actorLabel: row.actor_label,
      action: row.action,
      target: row.target,
      metadata: row.metadata,
      requestIp: row.request_ip,
    }));
  }

  // ─── Projects (sub-brains) ───────────────────────────────────────────────
  // Each entry can belong to at most one project; projects can span users
  // via `project_members`. The owner is also a member-row (role='owner').

  async createProject(args: {
    name: string;
    ownerUserId: string;
  }): Promise<{ id: string; name: string; ownerUserId: string; createdAt: Date }> {
    // Project id is a server-assigned ULID. Clients name projects in the
    // dashboard; the id is never user-visible (it surfaces only in
    // /v1/me/projects/:id URLs and cold-collection names).
    const id = ulid();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ created_at: Date }>(
        `INSERT INTO projects (id, name, owner_user_id) VALUES ($1, $2, $3)
         RETURNING created_at`,
        [id, args.name, args.ownerUserId],
      );
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [id, args.ownerUserId],
      );
      await client.query("COMMIT");
      return { id, name: args.name, ownerUserId: args.ownerUserId, createdAt: r.rows[0]!.created_at };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getProject(
    id: string,
  ): Promise<{ id: string; name: string; ownerUserId: string; createdAt: Date } | null> {
    const r = await this.pool.query<{
      id: string;
      name: string;
      owner_user_id: string;
      created_at: Date;
    }>(`SELECT id, name, owner_user_id, created_at FROM projects WHERE id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      createdAt: row.created_at,
    };
  }

  // ─── Persistent throughput samples ───────────────────────────────────

  /** Append (or upsert) a per-user 1-minute throughput bucket. Counts are
   *  totals observed in the window since the previous flush. */
  async recordMetricsSamples(
    samples: Array<{ userId: string; sampledAt: Date; queries: number; remembers: number }>,
  ): Promise<void> {
    if (samples.length === 0) return;
    // Multi-row insert via UNNEST. Conflicts (rare double-flush in the
    // same minute) accumulate counts so no observation is lost.
    const userIds = samples.map((s) => s.userId);
    const ats = samples.map((s) => s.sampledAt.toISOString());
    const queries = samples.map((s) => s.queries);
    const remembers = samples.map((s) => s.remembers);
    await this.pool.query(
      `INSERT INTO metrics_samples (user_id, sampled_at, queries, remembers)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::int[], $4::int[])
       ON CONFLICT (user_id, sampled_at) DO UPDATE SET
         queries = metrics_samples.queries + EXCLUDED.queries,
         remembers = metrics_samples.remembers + EXCLUDED.remembers`,
      [userIds, ats, queries, remembers],
    );
  }

  /** Drop samples older than the cutoff. Called from the flush loop so
   *  the table doesn't grow unbounded. */
  async pruneMetricsSamples(olderThan: Date): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM metrics_samples WHERE sampled_at < $1`,
      [olderThan.toISOString()],
    );
    return r.rowCount ?? 0;
  }

  /** 24h history (or whatever window) for a user, oldest first.
   *  Result is gap-free padded to 1-min buckets so the chart can render
   *  zeros where there was no activity. */
  async getMetricsHistory(
    userId: string,
    sinceMs: number,
  ): Promise<Array<{ sampledAt: Date; queries: number; remembers: number }>> {
    const since = new Date(sinceMs);
    const r = await this.pool.query<{
      sampled_at: Date;
      queries: number;
      remembers: number;
    }>(
      `SELECT sampled_at, queries, remembers
         FROM metrics_samples
        WHERE user_id = $1 AND sampled_at >= $2
        ORDER BY sampled_at ASC`,
      [userId, since.toISOString()],
    );
    return r.rows.map((row) => ({
      sampledAt: row.sampled_at,
      queries: Number(row.queries),
      remembers: Number(row.remembers),
    }));
  }

  /** Find a project the caller can access by its human name. Returns null
   *  if no such project exists in the caller's visibility (own + member
   *  of). Used by HTTP route helpers so callers can pass either a ULID
   *  or a human name in `project:` fields without having to look up the
   *  id first. Names aren't unique server-wide, but they ARE unique per
   *  caller's view in practice — when collisions exist, prefer the
   *  oldest match so behaviour is deterministic. */
  async findProjectByName(
    userId: string,
    name: string,
  ): Promise<{ id: string; name: string; ownerUserId: string; createdAt: Date } | null> {
    const r = await this.pool.query<{
      id: string;
      name: string;
      owner_user_id: string;
      created_at: Date;
    }>(
      `SELECT p.id, p.name, p.owner_user_id, p.created_at
         FROM projects p
         JOIN project_members m ON m.project_id = p.id
        WHERE p.name = $1 AND m.user_id = $2
        ORDER BY p.created_at ASC
        LIMIT 1`,
      [name, userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      createdAt: row.created_at,
    };
  }

  async listProjectsForUser(
    userId: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      role: string;
      ownerUserId: string;
      createdAt: Date;
    }>
  > {
    const r = await this.pool.query<{
      id: string;
      name: string;
      role: string;
      owner_user_id: string;
      created_at: Date;
    }>(
      `SELECT p.id, p.name, m.role, p.owner_user_id, p.created_at
         FROM projects p
         JOIN project_members m ON m.project_id = p.id
        WHERE m.user_id = $1
        ORDER BY p.created_at ASC`,
      [userId],
    );
    return r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      ownerUserId: row.owner_user_id,
      createdAt: row.created_at,
    }));
  }

  async listProjectMembers(
    projectId: string,
  ): Promise<
    Array<{ userId: string; username: string; role: string; joinedAt: Date }>
  > {
    const r = await this.pool.query<{
      user_id: string;
      username: string;
      role: string;
      joined_at: Date;
    }>(
      `SELECT m.user_id, u.username, m.role, m.joined_at
         FROM project_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1
        ORDER BY m.joined_at ASC`,
      [projectId],
    );
    return r.rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }

  async addProjectMember(projectId: string, userId: string, role: "owner" | "member"): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [projectId, userId, role],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async removeProjectMember(
    projectId: string,
    userId: string,
  ): Promise<{ removed: boolean }> {
    const r = await this.pool.query(
      `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    return { removed: (r.rowCount ?? 0) > 0 };
    /* (Tokens are user-scoped, not project-scoped. Removing a member
     *  drops their access to the project's memory but leaves their
     *  bearers alone — they still authenticate as that user.) */
  }

  async getProjectMembership(
    projectId: string,
    userId: string,
  ): Promise<{ role: string } | null> {
    const r = await this.pool.query<{ role: string }>(
      `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    return r.rows[0] ?? null;
  }

  /** Hard-delete a project: removes its memory entries (and FTS/access/
   *  relations rows), member rows, and the project row itself. The cold
   *  store / graph cleanup is the engine's responsibility (it has those
   *  store handles). */
  async deleteProject(id: string): Promise<{ deleted: boolean; entriesRemoved: number }> {
    const exists = await this.pool.query("SELECT 1 FROM projects WHERE id = $1", [id]);
    if (exists.rowCount === 0) return { deleted: false, entriesRemoved: 0 };
    const client = await this.pool.connect();
    let entriesRemoved = 0;
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM memory_access WHERE entry_id IN (SELECT id FROM memory_entries WHERE project_id = $1)`,
        [id],
      );
      await client.query("DELETE FROM memory_fts WHERE project_id = $1", [id]);
      await client.query("DELETE FROM memory_relations WHERE project_id = $1", [id]);
      const del = await client.query("DELETE FROM memory_entries WHERE project_id = $1", [id]);
      entriesRemoved = del.rowCount ?? 0;
      await client.query("DELETE FROM cold_orphans WHERE project_id = $1", [id]);
      await client.query("DELETE FROM project_members WHERE project_id = $1", [id]);
      // (Tokens have no project scope — they belong to the user, not the
      // project. The kicked / removed members keep their bearers; they
      // just no longer reach this project's memory.)
      await client.query("DELETE FROM projects WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { deleted: true, entriesRemoved };
  }

  async insertEntry(args: {
    userId: string;
    projectId?: string | null;
    content: string;
    namespace: string;
    source: string;
    agentName?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = ulid();
    await this.db.insert(schema.memoryEntries).values({
      id,
      userId: args.userId,
      projectId: args.projectId ?? null,
      content: args.content,
      namespace: args.namespace,
      source: args.source,
      agentName: args.agentName ?? null,
      metadata: args.metadata ?? {},
    });
    await this.db.insert(schema.memoryFts).values({
      entryId: id,
      userId: args.userId,
      projectId: args.projectId ?? null,
      content: args.content,
      namespace: args.namespace,
    });
    await this.db.insert(schema.memoryAccess).values({ entryId: id });
    return id;
  }

  /** Full-text keyword search via Postgres tsvector. Optional `agentName`
   *  scopes the result to one agent's entries (matches `IS NULL` if `null`
   *  is passed explicitly; omit the field for "any agent"). */
  async ftsSearch(args: {
    userId: string;
    /** When set, project IS the isolation unit — user_id is NOT filtered
     *  on (membership has already been verified at the auth layer, and
     *  project members may belong to different users). When null/
     *  undefined, scope to user-wide entries (project_id IS NULL) for
     *  the supplied user. */
    projectId?: string | null;
    query: string;
    /** Single-namespace search. Ignored when `namespaces` is set. */
    namespace: string;
    /** Cross-namespace search: when set, FTS unions across these shelves
     *  via `namespace = ANY(...)` instead of equality on the singular
     *  field. */
    namespaces?: string[];
    k: number;
    agentName?: string | null;
  }): Promise<Array<{ id: string; score: number }>> {
    const useAgent = args.agentName !== undefined;
    const isProject = args.projectId != null;
    const useNsArray = !!args.namespaces?.length;
    const params: unknown[] = [args.query, useNsArray ? args.namespaces! : args.namespace, args.k];
    const ph = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    const nsClause = useNsArray ? "namespace = ANY($2::text[])" : "namespace = $2";
    const scopeClause = isProject
      ? `project_id = ${ph(args.projectId)}`
      : `user_id = ${ph(args.userId)} AND project_id IS NULL`;
    const agentClause = !useAgent
      ? ""
      : args.agentName === null
        ? "AND e.agent_name IS NULL"
        : `AND e.agent_name = ${ph(args.agentName)}`;

    // For the join variant we need to disambiguate column references with
    // the table alias `f.` since both sides have project_id / user_id.
    const fScopeClause = scopeClause.replace(/(project_id|user_id)/g, "f.$1");
    const fNsClause = nsClause.replace(/^namespace/, "f.namespace");
    const sql = useAgent
      ? `SELECT f.entry_id,
                ts_rank(f.tsv, plainto_tsquery('english', $1)) AS score
           FROM memory_fts f
           JOIN memory_entries e ON e.id = f.entry_id
          WHERE ${fNsClause}
            AND ${fScopeClause}
            ${agentClause}
            AND f.tsv @@ plainto_tsquery('english', $1)
          ORDER BY score DESC
          LIMIT $3`
      : `SELECT entry_id,
                ts_rank(tsv, plainto_tsquery('english', $1)) AS score
           FROM memory_fts
          WHERE ${nsClause}
            AND ${scopeClause}
            AND tsv @@ plainto_tsquery('english', $1)
          ORDER BY score DESC
          LIMIT $3`;
    const rows = await this.pool.query<{ entry_id: string; score: number }>(sql, params);
    return rows.rows.map((r) => ({ id: r.entry_id, score: Number(r.score) }));
  }

  /** Look up a single entry, scoped to a user or project. This is the
   *  choke-point that enforces isolation on every read path that takes an
   *  id (search, neighbors, forget).
   *
   *  - `opts.projectId` is a non-empty string → the entry must match that
   *    project; user_id is decorative (cross-user members allowed).
   *  - `opts.projectId` is null/undefined → user-wide entries only, scoped
   *    to `userId`.
   *
   *  P0-4: the previous magic-string `"*"` bypass was removed; there is no
   *  way for an external caller to disable both checks. */
  /** Return the entry's `user_id` and `project_id` by id alone — no
   *  scope filter. Used by /v1/me/forget to recheck the actual project
   *  membership before deletion (the regular `getEntry` filters by the
   *  caller-supplied scope, which an attacker can game by passing null). */
  async getEntryScope(id: string): Promise<{ userId: string; projectId: string | null } | undefined> {
    const r = await this.pool.query<{ user_id: string; project_id: string | null }>(
      `SELECT user_id, project_id FROM memory_entries WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return { userId: row.user_id, projectId: row.project_id };
  }

  async getEntry(userId: string, id: string, opts: { projectId?: string | null } = {}) {
    const rows = await this.db
      .select()
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.id, id));
    const row = rows[0];
    if (!row) return undefined;
    if (typeof opts.projectId === "string") {
      // Project IS the access boundary when set.
      return row.projectId === opts.projectId ? row : undefined;
    }
    // No project requested → user-wide entries only, scoped to userId.
    if (row.projectId !== null) return undefined;
    return row.userId === userId ? row : undefined;
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

  /** Batch variant of `bumpHits` — one round-trip for the whole top-k.
   *  Used by `engine.search` to collapse the N+1 (P1-P1). */
  async bumpHitsMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      `INSERT INTO memory_access (entry_id, hits, last_accessed)
       SELECT id, 1, now() FROM unnest($1::text[]) AS u(id)
       ON CONFLICT (entry_id) DO UPDATE
         SET hits = memory_access.hits + 1, last_accessed = now()`,
      [ids],
    );
  }

  /** Batch entry lookup. Returns rows in the same order as the input ids
   *  (with undefined slots for missing/cross-scope). When `projectId` is
   *  set, project IS the access boundary; otherwise user_id is. */
  async getEntries(
    userId: string,
    ids: string[],
    opts: { projectId?: string | null; includeProjects?: string[] } = {},
  ): Promise<Array<typeof schema.memoryEntries.$inferSelect | undefined>> {
    if (ids.length === 0) return [];
    const rows = await this.pool.query<{
      id: string;
      user_id: string;
      project_id: string | null;
      content: string;
      namespace: string;
      source: string;
      agent_name: string | null;
      metadata: Record<string, unknown> | null;
      cold: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, user_id, project_id, content, namespace, source, agent_name,
              metadata, cold, created_at, updated_at
         FROM memory_entries WHERE id = ANY($1::text[])`,
      [ids],
    );
    const want = opts.projectId;
    const includeSet = opts.includeProjects?.length ? new Set(opts.includeProjects) : null;
    const byId = new Map<string, (typeof rows.rows)[number]>();
    for (const r of rows.rows) {
      if (includeSet) {
        // Active-project mode: row is visible if it's user-global for this
        // caller, OR it's in one of the listed (membership-checked) projects.
        const ok =
          (r.project_id === null && r.user_id === userId) ||
          (r.project_id !== null && includeSet.has(r.project_id));
        if (!ok) continue;
      } else if (typeof want === "string") {
        if (r.project_id !== want) continue;
      } else {
        if (r.project_id !== null) continue;
        if (r.user_id !== userId) continue;
      }
      byId.set(r.id, r);
    }
    return ids.map((id) => {
      const r = byId.get(id);
      if (!r) return undefined;
      return {
        id: r.id,
        userId: r.user_id,
        projectId: r.project_id,
        content: r.content,
        namespace: r.namespace,
        source: r.source,
        agentName: r.agent_name,
        metadata: r.metadata,
        cold: r.cold,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      } as typeof schema.memoryEntries.$inferSelect;
    });
  }

  async listColdCandidates(_effectiveDays: number, limit = 1000) {
    // Decay is a global, cross-user operation: idle entries from any
    // user are demoted by the same maths. The per-row user_id stays put
    // — engine queries use it on read-side, but decay doesn't need to scope.
    return this.pool.query<{ id: string; user_id: string; namespace: string; hits: number; idle_days: number }>(
      `SELECT e.id,
              e.user_id,
              e.namespace,
              COALESCE(a.hits, 0) AS hits,
              EXTRACT(EPOCH FROM (now() - COALESCE(a.last_accessed, e.created_at))) / 86400.0 AS idle_days
         FROM memory_entries e
         LEFT JOIN memory_access a ON a.entry_id = e.id
        WHERE e.cold = false
        ORDER BY COALESCE(a.last_accessed, e.created_at) ASC
        LIMIT $1`,
      [limit],
    );
  }

  /** Read the access-count + idle-days for a single entry — used by the
   *  cold→warm promotion path. Returns null when the entry has no access
   *  row at all (shouldn't happen for promotion candidates). */
  async getColdEntryStats(id: string): Promise<{ hits: number; idleDays: number } | null> {
    const r = await this.pool.query<{ hits: number; idle_days: string }>(
      `SELECT a.hits,
              EXTRACT(EPOCH FROM (now() - a.last_accessed)) / 86400.0 AS idle_days
         FROM memory_access a
        WHERE a.entry_id = $1
        LIMIT 1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { hits: Number(row.hits), idleDays: Number(row.idle_days) };
  }

  /** Persist a relation row alongside the graph edge. The graph store is
   *  authoritative for traversal; this table is the audit/fallback so the
   *  data survives a graph outage. UNIQUE (from, to, relation) makes this
   *  idempotent — repeat links bump the strength via DO UPDATE. */
  async addRelation(
    userId: string,
    fromId: string,
    toId: string,
    relation: string,
    strength: number,
    projectId?: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_relations (user_id, project_id, from_id, to_id, relation, strength)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (from_id, to_id, relation) DO UPDATE
         SET strength = EXCLUDED.strength`,
      [userId, projectId ?? null, fromId, toId, relation, strength],
    );
  }

  async markCold(id: string, cold: boolean): Promise<void> {
    await this.db
      .update(schema.memoryEntries)
      .set({ cold, updatedAt: new Date() })
      .where(eq(schema.memoryEntries.id, id));
  }

  async stats(userId: string) {
    const r = await this.pool.query<{ namespace: string; cold: boolean; count: string }>(
      `SELECT namespace, cold, COUNT(*)::text AS count
         FROM memory_entries
        WHERE user_id = $1
        GROUP BY namespace, cold`,
      [userId],
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
}
