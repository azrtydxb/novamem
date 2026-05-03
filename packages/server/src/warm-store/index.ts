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

export const PUBLIC_TENANT = "public";

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
    // single-tenant installs upgrade in place — pre-tenant rows backfill to
    // `public` via the column DEFAULT.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS tenants (
        id text PRIMARY KEY,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `INSERT INTO tenants (id, name) VALUES ('public', 'public')
         ON CONFLICT (id) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS tenant_tokens (
        token_hash text PRIMARY KEY,
        tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        label text,
        created_by_user_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      )`,
      `ALTER TABLE tenant_tokens ADD COLUMN IF NOT EXISTS created_by_user_id text`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_tenant ON tenant_tokens(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tenant_tokens(created_by_user_id)`,
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        username text NOT NULL,
        password_hash text NOT NULL,
        role text NOT NULL DEFAULT 'user',
        tenant_id text REFERENCES tenants(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz,
        password_changed_at timestamptz
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users(username)`,
      `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz`,
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
        owner_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_projects_owner_user ON projects(owner_user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_projects_owner_tenant ON projects(owner_tenant_id)`,
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
        tenant_id text NOT NULL DEFAULT 'public',
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
      `ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public'`,
      `CREATE INDEX IF NOT EXISTS idx_entries_tenant ON memory_entries(tenant_id)`,
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
        tenant_id text NOT NULL DEFAULT 'public',
        from_id text NOT NULL,
        to_id text NOT NULL,
        relation text NOT NULL DEFAULT 'co_occurs',
        strength real NOT NULL DEFAULT 1.0,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (from_id, to_id, relation)
      )`,
      `ALTER TABLE memory_relations ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public'`,
      `CREATE INDEX IF NOT EXISTS idx_relations_tenant ON memory_relations(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_id)`,
      `CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_id)`,
      `CREATE TABLE IF NOT EXISTS memory_fts (
        id serial PRIMARY KEY,
        entry_id text NOT NULL,
        tenant_id text NOT NULL DEFAULT 'public',
        content text NOT NULL,
        namespace text NOT NULL DEFAULT 'default',
        tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      )`,
      `ALTER TABLE memory_fts ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public'`,
      `CREATE INDEX IF NOT EXISTS idx_fts_tsv ON memory_fts USING gin(tsv)`,
      `CREATE INDEX IF NOT EXISTS idx_fts_tenant ON memory_fts(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_fts_namespace ON memory_fts(namespace)`,
      `CREATE INDEX IF NOT EXISTS idx_fts_entry ON memory_fts(entry_id)`,
      `CREATE TABLE IF NOT EXISTS cold_orphans (
        id text PRIMARY KEY,
        tenant_id text NOT NULL DEFAULT 'public',
        namespace text NOT NULL,
        attempts int NOT NULL DEFAULT 0,
        last_error text,
        first_seen timestamptz NOT NULL DEFAULT now(),
        last_attempt_at timestamptz
      )`,
      `ALTER TABLE cold_orphans ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public'`,
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
      `ALTER TABLE tenant_tokens ADD COLUMN IF NOT EXISTS project_id text`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_project ON tenant_tokens(project_id)`,
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
      // ─── Performance: composite indexes flagged in review (P1-P2) ───
      `CREATE INDEX IF NOT EXISTS idx_entries_tenant_cold ON memory_entries(tenant_id, cold)`,
      `CREATE INDEX IF NOT EXISTS idx_orphans_attempt_lastattempt ON cold_orphans(attempts, last_attempt_at)`,
    ];
    for (const stmt of ddl) {
      await this.pool.query(stmt);
    }
  }

  // ─── Tenants & tokens ─────────────────────────────────────────────────

  /** Create a new tenant. Idempotent on id collision (returns the existing
   *  tenant). `id` should be a short, URL-safe slug — clients embed it nowhere
   *  visible, but it ends up in qdrant collection names and graph node
   *  properties so keep it sane. */
  async createTenant(id: string, name: string): Promise<{ id: string; name: string }> {
    await this.pool.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [id, name],
    );
    const r = await this.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM tenants WHERE id = $1`,
      [id],
    );
    return r.rows[0]!;
  }

  async listTenants(): Promise<Array<{ id: string; name: string; createdAt: Date }>> {
    const r = await this.pool.query<{ id: string; name: string; created_at: Date }>(
      `SELECT id, name, created_at FROM tenants ORDER BY created_at ASC`,
    );
    return r.rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
  }

  /** Mint a new bearer token for a tenant. Returns the **plaintext** token —
   *  the caller is responsible for getting it to the user; the server keeps
   *  only the sha256 hash. Returns null if the tenant doesn't exist. */
  async createTenantToken(
    tenantId: string,
    label?: string,
    createdByUserId?: string | null,
    projectId?: string | null,
  ): Promise<{ token: string; tenantId: string; projectId: string | null; createdAt: Date } | null> {
    const exists = await this.pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
    if (exists.rowCount === 0) return null;
    const token = generateBearerToken();
    const tokenHash = hashToken(token);
    const r = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO tenant_tokens (token_hash, tenant_id, label, created_by_user_id, project_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING created_at`,
      [tokenHash, tenantId, label ?? null, createdByUserId ?? null, projectId ?? null],
    );
    return { token, tenantId, projectId: projectId ?? null, createdAt: r.rows[0]!.created_at };
  }

  /** Resolve a plaintext bearer token to its tenant id. Touches `last_used_at`
   *  on success so dormant tokens are visible to operators. Returns null on
   *  unknown or revoked tokens — never throw, the auth hook decides what 4xx
   *  to send. */
  async resolveTenantToken(
    plaintext: string,
  ): Promise<{
    tenantId: string;
    projectId: string | null;
    tokenHash: string;
    label: string | null;
  } | null> {
    if (!plaintext) return null;
    const tokenHash = hashToken(plaintext);
    const r = await this.pool.query<{
      tenant_id: string;
      project_id: string | null;
      label: string | null;
    }>(
      `UPDATE tenant_tokens SET last_used_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING tenant_id, project_id, label`,
      [tokenHash],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { tenantId: row.tenant_id, projectId: row.project_id, tokenHash, label: row.label };
  }

  async revokeTenantToken(plaintext: string): Promise<boolean> {
    const tokenHash = hashToken(plaintext);
    const r = await this.pool.query(
      `UPDATE tenant_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Revoke a token addressed by its sha256 hash, scoped to a tenant id.
   *  This is the path the admin dashboard uses — the server doesn't keep
   *  plaintext, but it does know each token's hash, and the listing surfaces
   *  it. The tenantId scoping prevents an admin from accidentally
   *  cross-revoking another tenant's token by hash collision typo. */
  async revokeTenantTokenByHash(tenantId: string, tokenHash: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE tenant_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [tokenHash, tenantId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Activity feed for the user dashboard "Today" page. Returns the
   *  last N events of mixed kinds (`remember` + `token` + project member
   *  joins) ranked by timestamp. Tenant-scoped. Auth audit log entries
   *  for this user are also included so the user can see their own
   *  password resets / role changes / etc. */
  async listRecentActivity(
    tenantId: string,
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
           FROM memory_entries WHERE tenant_id = $1
         UNION ALL
         SELECT 'token'::text AS kind, created_at AS at,
                'Minted token: ' || COALESCE(label, '(no label)') AS text,
                project_id AS project
           FROM tenant_tokens
          WHERE tenant_id = $1 AND created_by_user_id = $2
            AND revoked_at IS NULL
         UNION ALL
         SELECT 'project'::text AS kind, joined_at AS at,
                'Joined project: ' || project_id AS text,
                project_id AS project
           FROM project_members WHERE user_id = $2
         UNION ALL
         SELECT 'audit'::text AS kind, ts AS at,
                action || ' ' || COALESCE(target, '') AS text,
                NULL::text AS project
           FROM admin_audit_log WHERE actor_user_id = $2
       ) src
       ORDER BY at DESC
       LIMIT $3`,
      [tenantId, userId, lim],
    );
    return r.rows.map((row) => ({
      kind: row.kind as "remember" | "token" | "project" | "audit",
      at: row.at.toISOString(),
      text: row.text,
      project: row.project,
    }));
  }

  /** Tokens created by a specific user — used to scope per-token metrics
   *  to "my own tokens" on the user dashboard. Excludes revoked. */
  async listTokensCreatedByUser(
    userId: string,
  ): Promise<Array<{ tokenHash: string; label: string | null; tenantId: string }>> {
    const r = await this.pool.query<{
      token_hash: string;
      label: string | null;
      tenant_id: string;
    }>(
      `SELECT token_hash, label, tenant_id FROM tenant_tokens
        WHERE created_by_user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at ASC`,
      [userId],
    );
    return r.rows.map((row) => ({
      tokenHash: row.token_hash,
      label: row.label,
      tenantId: row.tenant_id,
    }));
  }

  async listTenantTokens(
    tenantId: string,
  ): Promise<
    Array<{
      tokenHash: string;
      label: string | null;
      createdByUserId: string | null;
      projectId: string | null;
      createdAt: Date;
      lastUsedAt: Date | null;
      revoked: boolean;
    }>
  > {
    const r = await this.pool.query<{
      token_hash: string;
      label: string | null;
      created_by_user_id: string | null;
      project_id: string | null;
      created_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT token_hash, label, created_by_user_id, project_id, created_at, last_used_at, revoked_at FROM tenant_tokens
        WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );
    return r.rows.map((row) => ({
      tokenHash: row.token_hash,
      label: row.label,
      createdByUserId: row.created_by_user_id,
      projectId: row.project_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revoked: row.revoked_at !== null,
    }));
  }

  /** Rotate a tenant's bearer token: revoke the current plaintext and mint a
   *  new one for the same tenant. Returns the new plaintext (shown once) or
   *  null when the supplied plaintext is unknown / already revoked. Used by
   *  the user-facing `POST /v1/me/rotate-token` endpoint — tenants don't
   *  have a dashboard, this is their only self-service operation. */
  async rotateTenantToken(
    plaintext: string,
  ): Promise<{ token: string; tenantId: string; createdAt: Date } | null> {
    const oldHash = hashToken(plaintext);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ tenant_id: string }>(
        `UPDATE tenant_tokens SET revoked_at = now()
          WHERE token_hash = $1 AND revoked_at IS NULL
          RETURNING tenant_id`,
        [oldHash],
      );
      const tenantId = r.rows[0]?.tenant_id;
      if (!tenantId) {
        await client.query("ROLLBACK");
        return null;
      }
      const token = generateBearerToken();
      const hash = hashToken(token);
      const ins = await client.query<{ created_at: Date }>(
        `INSERT INTO tenant_tokens (token_hash, tenant_id, label) VALUES ($1, $2, $3)
         RETURNING created_at`,
        [hash, tenantId, "rotated"],
      );
      await client.query("COMMIT");
      return { token, tenantId, createdAt: ins.rows[0]!.created_at };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Delete a tenant and every row owned by it across the warm store. The
   *  caller is responsible for purging cold collections and graph nodes
   *  separately — those live in different processes. Returns false when the
   *  tenant doesn't exist, or when the caller asks to delete the synthetic
   *  `public` tenant (which we refuse — it would orphan every legacy row). */
  async deleteTenant(id: string): Promise<{ deleted: boolean; entriesRemoved: number }> {
    if (id === PUBLIC_TENANT) return { deleted: false, entriesRemoved: 0 };
    const exists = await this.pool.query("SELECT 1 FROM tenants WHERE id = $1", [id]);
    if (exists.rowCount === 0) return { deleted: false, entriesRemoved: 0 };

    const client = await this.pool.connect();
    let entriesRemoved = 0;
    try {
      await client.query("BEGIN");
      // memory_access has no tenant_id column, so we delete by entry-id join.
      await client.query(
        `DELETE FROM memory_access WHERE entry_id IN (SELECT id FROM memory_entries WHERE tenant_id = $1)`,
        [id],
      );
      await client.query("DELETE FROM memory_fts WHERE tenant_id = $1", [id]);
      await client.query("DELETE FROM memory_relations WHERE tenant_id = $1", [id]);
      const del = await client.query("DELETE FROM memory_entries WHERE tenant_id = $1", [id]);
      entriesRemoved = del.rowCount ?? 0;
      await client.query("DELETE FROM cold_orphans WHERE tenant_id = $1", [id]);
      // tenant_tokens cascade-deletes via FK ON DELETE CASCADE.
      await client.query("DELETE FROM tenants WHERE id = $1", [id]);
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
    tenantId: string | null;
  }): Promise<{ id: string; username: string; role: string; tenantId: string | null; createdAt: Date; passwordChangedAt: Date | null }> {
    const id = ulid();
    const r = await this.pool.query<{ created_at: Date; password_changed_at: Date | null }>(
      `INSERT INTO users (id, username, password_hash, role, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING created_at, password_changed_at`,
      [id, args.username, args.passwordHash, args.role, args.tenantId],
    );
    return {
      id,
      username: args.username,
      role: args.role,
      tenantId: args.tenantId,
      createdAt: r.rows[0]!.created_at,
      passwordChangedAt: r.rows[0]!.password_changed_at,
    };
  }

  async findUserByUsername(username: string): Promise<{
    id: string;
    username: string;
    passwordHash: string;
    role: string;
    tenantId: string | null;
    passwordChangedAt: Date | null;
  } | null> {
    const r = await this.pool.query<{
      id: string;
      username: string;
      password_hash: string;
      role: string;
      tenant_id: string | null;
      password_changed_at: Date | null;
    }>(`SELECT id, username, password_hash, role, tenant_id, password_changed_at FROM users WHERE username = $1`, [username]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      tenantId: row.tenant_id,
      passwordChangedAt: row.password_changed_at,
    };
  }

  async findUserById(id: string): Promise<{
    id: string;
    username: string;
    role: string;
    tenantId: string | null;
  } | null> {
    const r = await this.pool.query<{
      id: string;
      username: string;
      role: string;
      tenant_id: string | null;
    }>(`SELECT id, username, role, tenant_id FROM users WHERE id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.id, username: row.username, role: row.role, tenantId: row.tenant_id };
  }

  async listUsers(): Promise<
    Array<{
      id: string;
      username: string;
      role: string;
      tenantId: string | null;
      createdAt: Date;
      lastLoginAt: Date | null;
    }>
  > {
    const r = await this.pool.query<{
      id: string;
      username: string;
      role: string;
      tenant_id: string | null;
      created_at: Date;
      last_login_at: Date | null;
    }>(`SELECT id, username, role, tenant_id, created_at, last_login_at FROM users ORDER BY created_at ASC`);
    return r.rows.map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      tenantId: row.tenant_id,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    }));
  }

  async deleteUser(id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM users WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async setUserRole(
    id: string,
    role: "admin" | "user",
    tenantId: string | null,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE users SET role = $1, tenant_id = $2 WHERE id = $3`,
      [role, tenantId, id],
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
    user: { id: string; username: string; role: string; tenantId: string | null };
  } | null> {
    if (!plaintext) return null;
    const tokenHash = hashToken(plaintext);
    const r = await this.pool.query<{
      user_id: string;
      username: string;
      role: string;
      tenant_id: string | null;
    }>(
      `UPDATE sessions SET last_seen_at = now()
        WHERE token_hash = $1 AND expires_at > now()
        RETURNING user_id,
                  (SELECT username FROM users u WHERE u.id = sessions.user_id) AS username,
                  (SELECT role FROM users u WHERE u.id = sessions.user_id) AS role,
                  (SELECT tenant_id FROM users u WHERE u.id = sessions.user_id) AS tenant_id`,
      [tokenHash],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      user: {
        id: row.user_id,
        username: row.username,
        role: row.role,
        tenantId: row.tenant_id,
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
  // Each entry can belong to at most one project; projects can span tenants
  // via `project_members`. The owner is also a member-row (role='owner').

  async createProject(args: {
    id: string;
    name: string;
    ownerUserId: string;
    ownerTenantId: string;
  }): Promise<{ id: string; name: string; ownerUserId: string; ownerTenantId: string; createdAt: Date }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ created_at: Date }>(
        `INSERT INTO projects (id, name, owner_user_id, owner_tenant_id) VALUES ($1, $2, $3, $4)
         RETURNING created_at`,
        [args.id, args.name, args.ownerUserId, args.ownerTenantId],
      );
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [args.id, args.ownerUserId],
      );
      await client.query("COMMIT");
      return { ...args, createdAt: r.rows[0]!.created_at };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getProject(
    id: string,
  ): Promise<{ id: string; name: string; ownerUserId: string; ownerTenantId: string; createdAt: Date } | null> {
    const r = await this.pool.query<{
      id: string;
      name: string;
      owner_user_id: string;
      owner_tenant_id: string;
      created_at: Date;
    }>(`SELECT id, name, owner_user_id, owner_tenant_id, created_at FROM projects WHERE id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      ownerTenantId: row.owner_tenant_id,
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
      ownerTenantId: string;
      createdAt: Date;
    }>
  > {
    const r = await this.pool.query<{
      id: string;
      name: string;
      role: string;
      owner_user_id: string;
      owner_tenant_id: string;
      created_at: Date;
    }>(
      `SELECT p.id, p.name, m.role, p.owner_user_id, p.owner_tenant_id, p.created_at
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
      ownerTenantId: row.owner_tenant_id,
      createdAt: row.created_at,
    }));
  }

  async listProjectMembers(
    projectId: string,
  ): Promise<
    Array<{ userId: string; username: string; tenantId: string | null; role: string; joinedAt: Date }>
  > {
    const r = await this.pool.query<{
      user_id: string;
      username: string;
      tenant_id: string | null;
      role: string;
      joined_at: Date;
    }>(
      `SELECT m.user_id, u.username, u.tenant_id, m.role, m.joined_at
         FROM project_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1
        ORDER BY m.joined_at ASC`,
      [projectId],
    );
    return r.rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      tenantId: row.tenant_id,
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
  ): Promise<{ removed: boolean; tokensRevoked: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const m = await client.query(
        `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`,
        [projectId, userId],
      );
      const removed = (m.rowCount ?? 0) > 0;
      // Auth fix (P0-2): an ex-member's project-scoped tokens stay valid
      // until explicit revoke. Revoke them at member-removal time so
      // access ends with the membership.
      let tokensRevoked = 0;
      if (removed) {
        const t = await client.query(
          `UPDATE tenant_tokens
              SET revoked_at = now()
            WHERE project_id = $1
              AND created_by_user_id = $2
              AND revoked_at IS NULL`,
          [projectId, userId],
        );
        tokensRevoked = t.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { removed, tokensRevoked };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
      // Tokens scoped to this project become invalid; revoke them.
      await client.query(
        `UPDATE tenant_tokens SET revoked_at = now() WHERE project_id = $1 AND revoked_at IS NULL`,
        [id],
      );
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
    tenantId: string;
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
      tenantId: args.tenantId,
      projectId: args.projectId ?? null,
      content: args.content,
      namespace: args.namespace,
      source: args.source,
      agentName: args.agentName ?? null,
      metadata: args.metadata ?? {},
    });
    await this.db.insert(schema.memoryFts).values({
      entryId: id,
      tenantId: args.tenantId,
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
    tenantId: string;
    /** When set, project IS the isolation unit — tenant_id is NOT filtered
     *  on (membership has already been verified at the auth layer, and
     *  project members may belong to different tenants). When null/
     *  undefined, scope to tenant-wide entries (project_id IS NULL) for
     *  the supplied tenant. */
    projectId?: string | null;
    query: string;
    namespace: string;
    k: number;
    agentName?: string | null;
  }): Promise<Array<{ id: string; score: number }>> {
    const useAgent = args.agentName !== undefined;
    const isProject = args.projectId != null;
    const params: unknown[] = [args.query, args.namespace, args.k];
    const ph = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    const scopeClause = isProject
      ? `project_id = ${ph(args.projectId)}`
      : `tenant_id = ${ph(args.tenantId)} AND project_id IS NULL`;
    const agentClause = !useAgent
      ? ""
      : args.agentName === null
        ? "AND e.agent_name IS NULL"
        : `AND e.agent_name = ${ph(args.agentName)}`;

    // For the join variant we need to disambiguate column references with
    // the table alias `f.` since both sides have project_id / tenant_id.
    const fScopeClause = scopeClause.replace(/(project_id|tenant_id)/g, "f.$1");
    const sql = useAgent
      ? `SELECT f.entry_id,
                ts_rank(f.tsv, plainto_tsquery('english', $1)) AS score
           FROM memory_fts f
           JOIN memory_entries e ON e.id = f.entry_id
          WHERE f.namespace = $2
            AND ${fScopeClause}
            ${agentClause}
            AND f.tsv @@ plainto_tsquery('english', $1)
          ORDER BY score DESC
          LIMIT $3`
      : `SELECT entry_id,
                ts_rank(tsv, plainto_tsquery('english', $1)) AS score
           FROM memory_fts
          WHERE namespace = $2
            AND ${scopeClause}
            AND tsv @@ plainto_tsquery('english', $1)
          ORDER BY score DESC
          LIMIT $3`;
    const rows = await this.pool.query<{ entry_id: string; score: number }>(sql, params);
    return rows.rows.map((r) => ({ id: r.entry_id, score: Number(r.score) }));
  }

  /** Look up a single entry, scoped to a tenant or project. This is the
   *  choke-point that enforces isolation on every read path that takes an
   *  id (search, neighbors, forget).
   *
   *  - `opts.projectId` is a non-empty string → the entry must match that
   *    project; tenant_id is decorative (cross-tenant members allowed).
   *  - `opts.projectId` is null/undefined → tenant-wide entries only, scoped
   *    to `tenantId`.
   *
   *  P0-4: the previous magic-string `"*"` bypass was removed; there is no
   *  way for an external caller to disable both checks. */
  /** Return the entry's `tenant_id` and `project_id` by id alone — no
   *  scope filter. Used by /v1/me/forget to recheck the actual project
   *  membership before deletion (the regular `getEntry` filters by the
   *  caller-supplied scope, which an attacker can game by passing null). */
  async getEntryScope(id: string): Promise<{ tenantId: string; projectId: string | null } | undefined> {
    const r = await this.pool.query<{ tenant_id: string; project_id: string | null }>(
      `SELECT tenant_id, project_id FROM memory_entries WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return { tenantId: row.tenant_id, projectId: row.project_id };
  }

  async getEntry(tenantId: string, id: string, opts: { projectId?: string | null } = {}) {
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
    // No project requested → tenant-wide entries only, scoped to tenantId.
    if (row.projectId !== null) return undefined;
    return row.tenantId === tenantId ? row : undefined;
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
   *  set, project IS the access boundary; otherwise tenant_id is. */
  async getEntries(
    tenantId: string,
    ids: string[],
    opts: { projectId?: string | null } = {},
  ): Promise<Array<typeof schema.memoryEntries.$inferSelect | undefined>> {
    if (ids.length === 0) return [];
    const rows = await this.pool.query<{
      id: string;
      tenant_id: string;
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
      `SELECT id, tenant_id, project_id, content, namespace, source, agent_name,
              metadata, cold, created_at, updated_at
         FROM memory_entries WHERE id = ANY($1::text[])`,
      [ids],
    );
    const want = opts.projectId;
    const byId = new Map<string, (typeof rows.rows)[number]>();
    for (const r of rows.rows) {
      if (typeof want === "string") {
        if (r.project_id !== want) continue;
      } else {
        if (r.project_id !== null) continue;
        if (r.tenant_id !== tenantId) continue;
      }
      byId.set(r.id, r);
    }
    return ids.map((id) => {
      const r = byId.get(id);
      if (!r) return undefined;
      return {
        id: r.id,
        tenantId: r.tenant_id,
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
    // Decay is a global, cross-tenant operation: idle entries from any
    // tenant are demoted by the same maths. The per-row tenant_id stays put
    // — engine queries use it on read-side, but decay doesn't need to scope.
    return this.pool.query<{ id: string; tenant_id: string; namespace: string; hits: number; idle_days: number }>(
      `SELECT e.id,
              e.tenant_id,
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
    tenantId: string,
    fromId: string,
    toId: string,
    relation: string,
    strength: number,
    projectId?: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_relations (tenant_id, project_id, from_id, to_id, relation, strength)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (from_id, to_id, relation) DO UPDATE
         SET strength = EXCLUDED.strength`,
      [tenantId, projectId ?? null, fromId, toId, relation, strength],
    );
  }

  async markCold(id: string, cold: boolean): Promise<void> {
    await this.db
      .update(schema.memoryEntries)
      .set({ cold, updatedAt: new Date() })
      .where(eq(schema.memoryEntries.id, id));
  }

  async stats(tenantId: string) {
    const r = await this.pool.query<{ namespace: string; cold: boolean; count: string }>(
      `SELECT namespace, cold, COUNT(*)::text AS count
         FROM memory_entries
        WHERE tenant_id = $1
        GROUP BY namespace, cold`,
      [tenantId],
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
