/**
 * Warm-store driver. Owns the Postgres pool and runs the SQL for the memory
 * primitives. The engine layer composes these calls into the public API
 * surface.
 *
 * Drizzle usage rule (issue #20): use the query-builder by default; drop
 * to `db.execute(sql\`…\`)` only when (a) joining a Better-Auth-owned
 * table (`"user"`, `"session"`, …) that isn't in our drizzle schema,
 * (b) using window functions / lateral joins / SQL we don't model, or
 * (c) bulk INSERT…SELECT. Each raw block must justify itself with a
 * one-line comment naming which exception applies.
 */

import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { ulid } from "ulid";

import * as schema from "./schema.js";

/** Plaintext bearer token format. 32 random bytes → 43 base64url chars,
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
  /** Postgres pool max connections. Sourced from `cfg.service.pgPoolMax`
   *  (default 20). Bounded so a load spike can't exhaust Postgres
   *  connections silently. */
  pgPoolMax?: number;
}

export class WarmStore {
  readonly db: WarmDB;
  /** Direct Postgres pool. Public so the engine can run ad-hoc SQL (e.g.
   *  `recent()` time-window queries) without parking another driver in
   *  this layer.
   *
   *  @internal Intended for use only within `engine/` and `warm-store/`.
   *    External callers must go through the typed methods on this class.
   */
  public readonly pool: Pool;

  constructor(cfg: WarmStoreConfig) {
    // Bound the pg connection pool so a load spike can't exhaust
    // Postgres connections silently. Default max=20 is well below typical
    // Postgres `max_connections` of 100 even when several server replicas
    // share a database. Validation + env parsing happens in
    // `loadConfig()` (config.ts) — this layer trusts what it's handed.
    this.pool = new Pool({
      connectionString: cfg.url,
      max: cfg.pgPoolMax ?? 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.db = drizzle(this.pool, { schema });
  }

  async initialize(): Promise<void> {
    // Three phases on every boot:
    //   1. Legacy cleanups — pre-Better-Auth FK constraints + dropped
    //      `users` / `sessions` tables. Idempotent; no-op on already-
    //      cutover databases.
    //   2. Better Auth + Postgres-FTS scaffolding. Tables Better Auth
    //      owns and the GENERATED `tsv` column on memory_fts that
    //      drizzle's schema DSL doesn't model.
    //   3. drizzle-kit `migrate()` over our 12 owned tables. Reads
    //      `dist/warm-store/migrations/` (or `src/.../migrations/` in
    //      dev under tsx) and applies anything new since the last run.
    //      The first migration uses CREATE … IF NOT EXISTS so it's a
    //      no-op on databases that pre-date drizzle-kit; subsequent
    //      migrations are plain.
    await this.runLegacyCleanups();
    await this.bootstrapBetterAuthAndFts();
    await migrate(this.db, { migrationsFolder: WarmStore.migrationsFolder() });
    await this.ensureFtsExtras();
  }

  /** Resolve the on-disk path of the migrations folder. The folder ships
   *  alongside the compiled JS in `dist/warm-store/migrations/`; in dev
   *  (tsx) it's the source path, which co-locates the same way. */
  private static migrationsFolder(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
  }

  /** Idempotent legacy DDL — drops constraints + tables left over from
   *  the pre-Better-Auth schema. CREATE TABLE IF NOT EXISTS isn't enough
   *  because the constraints survive on already-existing tables. */
  private async runLegacyCleanups(): Promise<void> {
    const stmts = [
      `ALTER TABLE IF EXISTS user_tokens DROP CONSTRAINT IF EXISTS user_tokens_user_id_fkey`,
      `ALTER TABLE IF EXISTS projects DROP CONSTRAINT IF EXISTS projects_owner_user_id_fkey`,
      `ALTER TABLE IF EXISTS project_members DROP CONSTRAINT IF EXISTS project_members_user_id_fkey`,
      // Legacy bcrypt + cookie path was retired with the Better Auth
      // cutover. Drop so they can't drift.
      `DROP TABLE IF EXISTS sessions`,
      `DROP TABLE IF EXISTS users`,
    ];
    for (const s of stmts) await this.pool.query(s);
  }

  /** Tables Better Auth owns + Postgres-specific bits drizzle can't
   *  model. Better Auth's own DDL would create these too, but keeping
   *  them here lets the server boot independently of when Better Auth
   *  initializes its handler. */
  private async bootstrapBetterAuthAndFts(): Promise<void> {
    const stmts = [
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
      // Postgres-FTS shadow column on memory_fts. drizzle's schema DSL
      // doesn't have GENERATED-column syntax, so we ALTER it in
      // post-migration. The ADD COLUMN IF NOT EXISTS makes this a no-op
      // on already-bootstrapped databases. Applied AFTER migrate() in
      // the no-op-after-first-boot case is fine because migrate() only
      // creates the bare memory_fts table (without tsv) on first run.
    ];
    for (const s of stmts) await this.pool.query(s);
  }

  /** Postgres-specific FTS additions that drizzle doesn't model.
   *  Called after `migrate()` so the memory_fts table exists. */
  private async ensureFtsExtras(): Promise<void> {
    await this.pool.query(
      `ALTER TABLE memory_fts
         ADD COLUMN IF NOT EXISTS tsv tsvector
         GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`,
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_fts_tsv ON memory_fts USING gin(tsv)`);
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
    // Raw: Better-Auth-owned `"user"` table not in our drizzle schema (rule a).
    const exists = await this.db.execute<{ exists: number }>(
      sql`SELECT 1 AS exists FROM "user" WHERE id = ${userId} LIMIT 1`,
    );
    if (exists.rowCount === 0) return null;
    const token = generateBearerToken();
    const tokenHash = hashToken(token);
    const [row] = await this.db
      .insert(schema.userTokens)
      .values({ tokenHash, userId, label: label ?? null })
      .returning({ createdAt: schema.userTokens.createdAt });
    return { token, userId, createdAt: row!.createdAt };
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
    const rows = await this.db
      .update(schema.userTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(and(eq(schema.userTokens.tokenHash, tokenHash), isNull(schema.userTokens.revokedAt)))
      .returning({ userId: schema.userTokens.userId, label: schema.userTokens.label });
    const row = rows[0];
    if (!row) return null;
    return { userId: row.userId, tokenHash, label: row.label };
  }

  async revokeUserToken(plaintext: string): Promise<boolean> {
    const tokenHash = hashToken(plaintext);
    const rows = await this.db
      .update(schema.userTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(schema.userTokens.tokenHash, tokenHash), isNull(schema.userTokens.revokedAt)))
      .returning({ tokenHash: schema.userTokens.tokenHash });
    return rows.length > 0;
  }

  /** Hard-delete a token by sha256 hash. Used by the user dashboard's
   *  delete-token action so the row disappears from the list outright —
   *  the soft revoke would leave dead entries cluttering the table. */
  async deleteUserTokenByHash(userId: string, tokenHash: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.userTokens)
      .where(and(eq(schema.userTokens.tokenHash, tokenHash), eq(schema.userTokens.userId, userId)))
      .returning({ tokenHash: schema.userTokens.tokenHash });
    return rows.length > 0;
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
    // Four-arm UNION ALL: remembers, token mints, project joins, audit
    // events for this user. user_tokens has no project_id column, so
    // we synthesise NULL there. drizzle's `unionAll` requires matching
    // shapes across all branches.
    const remembers = this.db
      .select({
        kind: sql<"remember" | "token" | "project" | "audit">`'remember'::text`,
        at: schema.memoryEntries.createdAt,
        text: sql<string>`left(${schema.memoryEntries.content}, 160)`,
        project: schema.memoryEntries.projectId,
      })
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.userId, userId));
    const tokens = this.db
      .select({
        kind: sql<"remember" | "token" | "project" | "audit">`'token'::text`,
        at: schema.userTokens.createdAt,
        text: sql<string>`'Minted token: ' || COALESCE(${schema.userTokens.label}, '(no label)')`,
        project: sql<string | null>`NULL::text`,
      })
      .from(schema.userTokens)
      .where(and(eq(schema.userTokens.userId, userId), isNull(schema.userTokens.revokedAt)));
    const joins = this.db
      .select({
        kind: sql<"remember" | "token" | "project" | "audit">`'project'::text`,
        at: schema.projectMembers.joinedAt,
        text: sql<string>`'Joined project: ' || ${schema.projectMembers.projectId}`,
        project: schema.projectMembers.projectId,
      })
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, userId));
    const audits = this.db
      .select({
        kind: sql<"remember" | "token" | "project" | "audit">`'audit'::text`,
        at: schema.adminAuditLog.ts,
        text: sql<string>`${schema.adminAuditLog.action} || ' ' || COALESCE(${schema.adminAuditLog.target}, '')`,
        project: sql<string | null>`NULL::text`,
      })
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.actorUserId, userId));
    // Order by the 2nd column (the timestamp). drizzle's `select({at: ...})`
    // names the JS property `at` but does not emit a SQL `AS at` alias for
    // the underlying column, so the outer UNION's ORDER BY can't reference
    // `at` by name. Positional ordering is the portable fix for UNION ALL.
    const rows = await unionAll(remembers, tokens)
      .unionAll(joins)
      .unionAll(audits)
      .orderBy(sql`2 DESC`)
      .limit(lim);
    return rows.map((row) => ({
      kind: row.kind,
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
    const rows = await this.db
      .select({
        tokenHash: schema.userTokens.tokenHash,
        label: schema.userTokens.label,
        userId: schema.userTokens.userId,
      })
      .from(schema.userTokens)
      .where(and(eq(schema.userTokens.userId, userId), isNull(schema.userTokens.revokedAt)))
      .orderBy(asc(schema.userTokens.createdAt));
    return rows;
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
    const rows = await this.db
      .select({
        tokenHash: schema.userTokens.tokenHash,
        label: schema.userTokens.label,
        createdAt: schema.userTokens.createdAt,
        lastUsedAt: schema.userTokens.lastUsedAt,
        revokedAt: schema.userTokens.revokedAt,
      })
      .from(schema.userTokens)
      .where(eq(schema.userTokens.userId, userId))
      .orderBy(asc(schema.userTokens.createdAt));
    return rows.map((r) => ({
      tokenHash: r.tokenHash,
      label: r.label,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revoked: r.revokedAt !== null,
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
    return this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(schema.userTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(schema.userTokens.tokenHash, oldHash), isNull(schema.userTokens.revokedAt)))
        .returning({ userId: schema.userTokens.userId });
      const userId = revoked[0]?.userId;
      if (!userId) return null;
      const token = generateBearerToken();
      const tokenHash = hashToken(token);
      const [inserted] = await tx
        .insert(schema.userTokens)
        .values({ tokenHash, userId, label: "rotated" })
        .returning({ createdAt: schema.userTokens.createdAt });
      return { token, userId, createdAt: inserted!.createdAt };
    });
  }

  // ─── Users ────────────────────────────────────────────────────────────
  // Better Auth owns the user model — its `"user"` table isn't in our
  // drizzle schema, so the lookups below use `db.execute(sql`…`)`. The
  // legacy `users` / `sessions` tables and their CRUD methods (createUser,
  // listUsers, createSession, deleteUserAndMemory, …) were dropped along
  // with the bcrypt path; tests run against FakeWarmStore which still
  // implements them in-memory.

  /** Strict, case-insensitive email-only lookup. Used by the
   *  project-share / add-member flow where a fuzzy match could let an
   *  attacker register a benign email with `name = "alice"` and be
   *  invited in alice's place. Display-name disambiguation belongs in
   *  the dashboard UI, not here. */
  async findUserByExactEmail(email: string): Promise<{
    id: string;
    username: string;
    role: string;
  } | null> {
    const r = await this.db.execute<{
      id: string;
      email: string;
      role: string | null;
    }>(sql`
      SELECT id, email, role FROM "user"
       WHERE lower(email) = lower(${email})
       LIMIT 1
    `);
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.id, username: row.email, role: row.role ?? "user" };
  }

  /** Resolve a user by their human handle: tries email exact-match first
   *  (Better Auth's canonical identifier), then falls back to `name` and
   *  the email's local-part. SECURITY: do NOT use this for project shares
   *  or any authorisation decision — `name` is not unique. Use
   *  `findUserByExactEmail` there. Kept for non-security UI flows that
   *  want a best-effort handle lookup. */
  async findUserByUsername(username: string): Promise<{
    id: string;
    username: string;
    role: string;
  } | null> {
    const r = await this.db.execute<{
      id: string;
      email: string;
      name: string;
      role: string | null;
    }>(sql`
      SELECT id, email, name, role FROM "user"
       WHERE email = ${username}
          OR name = ${username}
          OR split_part(email, '@', 1) = ${username}
       ORDER BY (CASE WHEN email = ${username} THEN 0
                      WHEN name  = ${username} THEN 1
                      ELSE 2 END)
       LIMIT 1
    `);
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      // Surface email as the username (callers display it, agents
      // recognise it). The local-part is too lossy when we have the
      // full email available.
      username: row.email,
      role: row.role ?? "user",
    };
  }

  /** Active-project pointer for the agent's current "scope" — see the
   *  user_active_project table comment in the DDL block. */
  async getActiveProject(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectId: schema.userActiveProject.projectId })
      .from(schema.userActiveProject)
      .where(eq(schema.userActiveProject.userId, userId))
      .limit(1);
    return row?.projectId ?? null;
  }

  /** Set or clear the active-project pointer. Pass null to deactivate. */
  async setActiveProject(userId: string, projectId: string | null): Promise<void> {
    if (projectId === null) {
      await this.db
        .delete(schema.userActiveProject)
        .where(eq(schema.userActiveProject.userId, userId));
      return;
    }
    await this.db
      .insert(schema.userActiveProject)
      .values({ userId, projectId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.userActiveProject.userId,
        set: { projectId, updatedAt: sql`now()` },
      });
  }

  async findUserById(id: string): Promise<{
    id: string;
    username: string;
    role: string;
  } | null> {
    // Better Auth's `"user"` table has email + name (no username); we
    // surface the full email as `username` to match `findUserByUsername`
    // / `findUserByExactEmail` — see issue #21. Callers (auth hook
    // fallback for nm_ tokens, audit-log labels, dashboard /v1/me) all
    // display it directly.
    const r = await this.db.execute<{
      id: string;
      email: string;
      name: string;
      role: string | null;
    }>(sql`SELECT id, email, name, role FROM "user" WHERE id = ${id}`);
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.email,
      role: row.role ?? "user",
    };
  }

  /** Bootstrap-only admin promotion. Better Auth's /admin/set-role
   *  endpoint requires admin auth, so the very first admin (seeded from
   *  NOVAMEM_BOOTSTRAP_ADMIN_*) has nobody to make the call. Direct
   *  UPDATE on the `"user"` table is the documented escape hatch — kept
   *  here so all writes to BA tables go through the warm store. */
  async promoteToAdmin(userId: string): Promise<void> {
    await this.db.execute(
      sql`UPDATE "user" SET role = 'admin', "updatedAt" = now() WHERE id = ${userId}`,
    );
  }

  // ─── Audit log ────────────────────────────────────────────────────────

  async writeAudit(entry: {
    actorUserId?: string | null;
    actorLabel: string;
    action: string;
    target?: string | null;
    metadata?: Record<string, unknown>;
    requestIp?: string | null;
  }): Promise<void> {
    await this.db.insert(schema.adminAuditLog).values({
      actorUserId: entry.actorUserId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      target: entry.target ?? null,
      metadata: entry.metadata ?? null,
      requestIp: entry.requestIp ?? null,
    });
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
    const rows = await this.db
      .select()
      .from(schema.adminAuditLog)
      .orderBy(desc(schema.adminAuditLog.id))
      .limit(opts.limit ?? 200);
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actorUserId: r.actorUserId,
      actorLabel: r.actorLabel,
      action: r.action,
      target: r.target,
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      requestIp: r.requestIp,
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
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.projects)
        .values({ id, name: args.name, ownerUserId: args.ownerUserId })
        .returning({ createdAt: schema.projects.createdAt });
      await tx
        .insert(schema.projectMembers)
        .values({ projectId: id, userId: args.ownerUserId, role: "owner" });
      return {
        id,
        name: args.name,
        ownerUserId: args.ownerUserId,
        createdAt: row!.createdAt,
      };
    });
  }

  async getProject(
    id: string,
  ): Promise<{ id: string; name: string; ownerUserId: string; createdAt: Date } | null> {
    const [row] = await this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .limit(1);
    return row ?? null;
  }

  // ─── Persistent throughput samples ───────────────────────────────────

  /** Append (or upsert) a per-user 1-minute throughput bucket. Counts are
   *  totals observed in the window since the previous flush. */
  async recordMetricsSamples(
    samples: Array<{ userId: string; sampledAt: Date; queries: number; remembers: number }>,
  ): Promise<void> {
    if (samples.length === 0) return;
    // Bulk insert with ON CONFLICT accumulating counts so no observation
    // is lost when a double-flush hits the same minute bucket.
    await this.db
      .insert(schema.metricsSamples)
      .values(samples)
      .onConflictDoUpdate({
        target: [schema.metricsSamples.userId, schema.metricsSamples.sampledAt],
        set: {
          queries: sql`${schema.metricsSamples.queries} + EXCLUDED.queries`,
          remembers: sql`${schema.metricsSamples.remembers} + EXCLUDED.remembers`,
        },
      });
  }

  /** Drop samples older than the cutoff. Called from the flush loop so
   *  the table doesn't grow unbounded. */
  async pruneMetricsSamples(olderThan: Date): Promise<number> {
    const rows = await this.db
      .delete(schema.metricsSamples)
      .where(lt(schema.metricsSamples.sampledAt, olderThan))
      .returning({ userId: schema.metricsSamples.userId });
    return rows.length;
  }

  /** 24h history (or whatever window) for a user, oldest first.
   *  Result is gap-free padded to 1-min buckets so the chart can render
   *  zeros where there was no activity. */
  async getMetricsHistory(
    userId: string,
    sinceMs: number,
  ): Promise<Array<{ sampledAt: Date; queries: number; remembers: number }>> {
    const since = new Date(sinceMs);
    const rows = await this.db
      .select({
        sampledAt: schema.metricsSamples.sampledAt,
        queries: schema.metricsSamples.queries,
        remembers: schema.metricsSamples.remembers,
      })
      .from(schema.metricsSamples)
      .where(
        and(
          eq(schema.metricsSamples.userId, userId),
          gte(schema.metricsSamples.sampledAt, since),
        ),
      )
      .orderBy(asc(schema.metricsSamples.sampledAt));
    return rows;
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
    const [row] = await this.db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        ownerUserId: schema.projects.ownerUserId,
        createdAt: schema.projects.createdAt,
      })
      .from(schema.projects)
      .innerJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
      .where(and(eq(schema.projects.name, name), eq(schema.projectMembers.userId, userId)))
      .orderBy(asc(schema.projects.createdAt))
      .limit(1);
    return row ?? null;
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
    const rows = await this.db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        role: schema.projectMembers.role,
        ownerUserId: schema.projects.ownerUserId,
        createdAt: schema.projects.createdAt,
      })
      .from(schema.projects)
      .innerJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
      .where(eq(schema.projectMembers.userId, userId))
      .orderBy(asc(schema.projects.createdAt));
    return rows;
  }

  async listProjectMembers(
    projectId: string,
  ): Promise<
    Array<{ userId: string; username: string; role: string; joinedAt: Date }>
  > {
    // Better Auth's `"user"` table isn't in our drizzle schema (it owns
    // its own DDL), so the join uses `sql` for the table reference and
    // column projection while drizzle handles the rest.
    const r = await this.db.execute<{
      user_id: string;
      username: string;
      role: string;
      joined_at: Date;
    }>(sql`
      SELECT ${schema.projectMembers.userId} AS user_id,
             u.email AS username,
             ${schema.projectMembers.role} AS role,
             ${schema.projectMembers.joinedAt} AS joined_at
        FROM ${schema.projectMembers}
        JOIN "user" u ON u.id = ${schema.projectMembers.userId}
       WHERE ${schema.projectMembers.projectId} = ${projectId}
       ORDER BY ${schema.projectMembers.joinedAt} ASC
    `);
    return r.rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }

  async addProjectMember(projectId: string, userId: string, role: "owner" | "member"): Promise<boolean> {
    const inserted = await this.db
      .insert(schema.projectMembers)
      .values({ projectId, userId, role })
      .onConflictDoNothing({
        target: [schema.projectMembers.projectId, schema.projectMembers.userId],
      })
      .returning({ userId: schema.projectMembers.userId });
    return inserted.length > 0;
  }

  async removeProjectMember(
    projectId: string,
    userId: string,
  ): Promise<{ removed: boolean }> {
    const removed = await this.db
      .delete(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, userId),
        ),
      )
      .returning({ userId: schema.projectMembers.userId });
    return { removed: removed.length > 0 };
    /* (Tokens are user-scoped, not project-scoped. Removing a member
     *  drops their access to the project's memory but leaves their
     *  bearers alone — they still authenticate as that user.) */
  }

  async getProjectMembership(
    projectId: string,
    userId: string,
  ): Promise<{ role: string } | null> {
    const [row] = await this.db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Hard-delete a project: removes its memory entries (and FTS/access/
   *  relations rows), member rows, and the project row itself. The cold
   *  store / graph cleanup is the engine's responsibility (it has those
   *  store handles). */
  async deleteProject(id: string): Promise<{ deleted: boolean; entriesRemoved: number }> {
    const [exists] = await this.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .limit(1);
    if (!exists) return { deleted: false, entriesRemoved: 0 };
    return this.db.transaction(async (tx) => {
      // memory_access doesn't have a project_id column, so we delete by
      // the entry-id subquery — drizzle's `inArray` over a subquery handles it.
      await tx.execute(sql`
        DELETE FROM memory_access WHERE entry_id IN (
          SELECT id FROM memory_entries WHERE project_id = ${id}
        )
      `);
      await tx.delete(schema.memoryFts).where(eq(schema.memoryFts.projectId, id));
      await tx.delete(schema.memoryRelations).where(eq(schema.memoryRelations.projectId, id));
      const removed = await tx
        .delete(schema.memoryEntries)
        .where(eq(schema.memoryEntries.projectId, id))
        .returning({ id: schema.memoryEntries.id });
      await tx.delete(schema.coldOrphans).where(eq(schema.coldOrphans.projectId, id));
      await tx
        .delete(schema.projectMembers)
        .where(eq(schema.projectMembers.projectId, id));
      // (Tokens have no project scope — they belong to the user, not the
      // project. The kicked / removed members keep their bearers; they
      // just no longer reach this project's memory.)
      await tx.delete(schema.projects).where(eq(schema.projects.id, id));
      return { deleted: true, entriesRemoved: removed.length };
    });
  }

  async insertEntry(args: {
    userId: string;
    projectId?: string | null;
    content: string;
    namespace: string;
    source: string;
    agentName?: string | null;
    metadata?: Record<string, unknown>;
    sourceType?: string | null;
    capturedFrom?: string | null;
    confidence?: number;
    contentHash?: string | null;
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
      sourceType: args.sourceType ?? null,
      capturedFrom: args.capturedFrom ?? null,
      ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
      contentHash: args.contentHash ?? null,
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

  /** Look up an existing entry by content hash within a user's scope.
   *  Used by the worthiness gate to short-circuit exact duplicates
   *  without re-embedding. Returns the existing entry's id when found. */
  async findByContentHash(
    userId: string,
    projectId: string | null,
    contentHash: string,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ id: schema.memoryEntries.id })
      .from(schema.memoryEntries)
      .where(
        and(
          eq(schema.memoryEntries.userId, userId),
          eq(schema.memoryEntries.contentHash, contentHash),
          projectId === null
            ? isNull(schema.memoryEntries.projectId)
            : eq(schema.memoryEntries.projectId, projectId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  /** Update an existing entry's content and/or metadata in-place.
   *  Preserves id, created_at, hits, last_accessed, and graph edges.
   *  Updates updated_at and (when content changed) the FTS shadow row +
   *  content_hash. Caller is responsible for re-embedding the cold
   *  vector (engine.update does that). Returns false when no row exists
   *  in the caller's scope. */
  async updateEntry(args: {
    userId: string;
    id: string;
    projectId?: string | null;
    content?: string;
    namespace?: string;
    metadata?: Record<string, unknown>;
    sourceType?: string;
    capturedFrom?: string;
    confidence?: number;
    contentHash?: string;
  }): Promise<boolean> {
    // Scope check — same boundary as getEntry. Project members may belong
    // to different users so projectId is the access boundary when set.
    const want = args.projectId;
    const scope = await this.getEntryScope(args.id);
    if (!scope) return false;
    if (typeof want === "string") {
      if (scope.projectId !== want) return false;
    } else {
      if (scope.projectId !== null) return false;
      if (scope.userId !== args.userId) return false;
    }
    // Partial update — drizzle's `.set()` accepts SQL-or-value per column
    // (the `$inferInsert` projection types `updatedAt` as Date, but
    // drizzle's set-source widens to `Date | SQL`). The narrow cast on
    // `sql<Date>\`now()\`` keeps the SQL-fragment generic-typed so a
    // future rename of `updatedAt` to a non-Date column would surface
    // as a type error here, not as a silent write. */
    const patch: Partial<typeof schema.memoryEntries.$inferInsert> = {
      updatedAt: sql<Date>`now()` as unknown as Date,
    };
    if (args.content !== undefined) patch.content = args.content;
    if (args.namespace !== undefined) patch.namespace = args.namespace;
    if (args.metadata !== undefined) patch.metadata = args.metadata;
    if (args.sourceType !== undefined) patch.sourceType = args.sourceType;
    if (args.capturedFrom !== undefined) patch.capturedFrom = args.capturedFrom;
    if (args.confidence !== undefined) patch.confidence = args.confidence;
    if (args.contentHash !== undefined) patch.contentHash = args.contentHash;
    await this.db
      .update(schema.memoryEntries)
      .set(patch)
      .where(eq(schema.memoryEntries.id, args.id));
    // FTS shadow has its own row keyed by entry_id — refresh content +
    // namespace when they change so keyword search picks up the rewrite.
    if (args.content !== undefined || args.namespace !== undefined) {
      const fPatch: Partial<typeof schema.memoryFts.$inferInsert> = {};
      if (args.content !== undefined) fPatch.content = args.content;
      if (args.namespace !== undefined) fPatch.namespace = args.namespace;
      await this.db
        .update(schema.memoryFts)
        .set(fPatch)
        .where(eq(schema.memoryFts.entryId, args.id));
    }
    return true;
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
    const isProject = args.projectId != null;
    const useNsArray = !!args.namespaces?.length;
    // ts_rank + tsv + plainto_tsquery are Postgres-specific expressions —
    // wrap each in `sql` so drizzle binds parameters but emits the raw
    // operator. Memory_fts.tsv is a GENERATED column not in the schema;
    // refer to it by raw column name.
    const score = sql<number>`ts_rank(${schema.memoryFts}.tsv, plainto_tsquery('english', ${args.query}))`;
    const tsvMatch = sql`${schema.memoryFts}.tsv @@ plainto_tsquery('english', ${args.query})`;
    const nsMatch = useNsArray
      ? inArray(schema.memoryFts.namespace, args.namespaces!)
      : eq(schema.memoryFts.namespace, args.namespace);
    const scopeMatch = isProject
      ? eq(schema.memoryFts.projectId, args.projectId!)
      : and(eq(schema.memoryFts.userId, args.userId), isNull(schema.memoryFts.projectId));

    if (args.agentName !== undefined) {
      // Agent filter requires the join to memory_entries since agent_name
      // lives there, not on memory_fts.
      const agentMatch =
        args.agentName === null
          ? isNull(schema.memoryEntries.agentName)
          : eq(schema.memoryEntries.agentName, args.agentName);
      const rows = await this.db
        .select({ id: schema.memoryFts.entryId, score })
        .from(schema.memoryFts)
        .innerJoin(schema.memoryEntries, eq(schema.memoryEntries.id, schema.memoryFts.entryId))
        .where(and(nsMatch, scopeMatch, agentMatch, tsvMatch))
        .orderBy(desc(score))
        .limit(args.k);
      return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
    }
    const rows = await this.db
      .select({ id: schema.memoryFts.entryId, score })
      .from(schema.memoryFts)
      .where(and(nsMatch, scopeMatch, tsvMatch))
      .orderBy(desc(score))
      .limit(args.k);
    return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
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
   *  The previous magic-string `"*"` bypass was removed; there is no
   *  way for an external caller to disable both checks. */
  /** Return the entry's `user_id` and `project_id` by id alone — no
   *  scope filter. Used by /v1/me/forget to recheck the actual project
   *  membership before deletion (the regular `getEntry` filters by the
   *  caller-supplied scope, which an attacker can game by passing null). */
  async getEntryScope(id: string): Promise<{ userId: string; projectId: string | null } | undefined> {
    const [row] = await this.db
      .select({ userId: schema.memoryEntries.userId, projectId: schema.memoryEntries.projectId })
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.id, id))
      .limit(1);
    return row;
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
    await this.db
      .insert(schema.memoryAccess)
      .values({ entryId: id, hits: 1, lastAccessed: sql`now()` })
      .onConflictDoUpdate({
        target: schema.memoryAccess.entryId,
        set: {
          hits: sql`${schema.memoryAccess.hits} + 1`,
          lastAccessed: sql`now()`,
        },
      });
  }

  /** Batch variant of `bumpHits` — one round-trip for the whole top-k.
   *  Used by `engine.search` to collapse the N+1.
   *
   *  Dedupes the input internally: Postgres rejects `ON CONFLICT DO UPDATE`
   *  when the same target row appears twice in a single statement
   *  ("command cannot affect row a second time"). The engine doesn't
   *  pass dupes today, but this is the defensive contract. */
  async bumpHitsMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const unique = Array.from(new Set(ids));
    await this.db
      .insert(schema.memoryAccess)
      .values(unique.map((entryId) => ({ entryId, hits: 1, lastAccessed: sql<Date>`now()` })))
      .onConflictDoUpdate({
        target: schema.memoryAccess.entryId,
        set: {
          hits: sql`${schema.memoryAccess.hits} + 1`,
          lastAccessed: sql`now()`,
        },
      });
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
    const rows = await this.db
      .select()
      .from(schema.memoryEntries)
      .where(inArray(schema.memoryEntries.id, ids));
    const want = opts.projectId;
    const includeSet = opts.includeProjects?.length ? new Set(opts.includeProjects) : null;
    const byId = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (includeSet) {
        // Active-project mode: row is visible if it's user-global for this
        // caller, OR it's in one of the listed (membership-checked) projects.
        const ok =
          (r.projectId === null && r.userId === userId) ||
          (r.projectId !== null && includeSet.has(r.projectId));
        if (!ok) continue;
      } else if (typeof want === "string") {
        if (r.projectId !== want) continue;
      } else {
        if (r.projectId !== null) continue;
        if (r.userId !== userId) continue;
      }
      byId.set(r.id, r);
    }
    return ids.map((id) => byId.get(id));
  }

  /** Recent entries within an isolation scope, newest first. Replaces a
   *  hand-built parameter-counted SQL string in the engine — using drizzle
   *  here keeps namespace / project / user / since predicates composable
   *  without off-by-one risk. Mirrors `getEntries`' isolation rules:
   *
   *    - active-project mode (`includeProjects` set): rows visible if
   *      they're user-global for this caller OR live in one of the
   *      listed (membership-checked) projects.
   *    - project-scoped (`projectId` is a string): scope by project_id.
   *      Cross-user members are allowed because project IS the boundary.
   *    - user-wide (`projectId` null/undefined): user_id matches AND
   *      project_id IS NULL.
   */
  async listRecent(
    userId: string,
    args: {
      namespaces: string[];
      k: number;
      projectId?: string | null;
      includeProjects?: string[] | null;
      since?: Date | null;
    },
  ): Promise<Array<typeof schema.memoryEntries.$inferSelect>> {
    const { namespaces, k, projectId = null, includeProjects = null, since = null } = args;
    if (namespaces.length === 0) return [];
    const isActive = !!includeProjects && includeProjects.length > 0;
    const isProject = !isActive && typeof projectId === "string";
    const scopeClause = isActive
      ? or(
          and(eq(schema.memoryEntries.userId, userId), isNull(schema.memoryEntries.projectId)),
          inArray(schema.memoryEntries.projectId, includeProjects),
        )
      : isProject
        ? eq(schema.memoryEntries.projectId, projectId as string)
        : and(eq(schema.memoryEntries.userId, userId), isNull(schema.memoryEntries.projectId));
    const sinceClause = since ? gte(schema.memoryEntries.createdAt, since) : undefined;
    const where = and(
      inArray(schema.memoryEntries.namespace, namespaces),
      scopeClause,
      sinceClause,
    );
    return await this.db
      .select()
      .from(schema.memoryEntries)
      .where(where)
      .orderBy(desc(schema.memoryEntries.createdAt))
      .limit(k);
  }

  /** Batch variant of `getColdEntryStats` — one round-trip for the whole
   *  cold-tier slice of a search top-k. Returns a Map keyed by entry id;
   *  ids without an access row are absent from the map. Used by the
   *  cold→warm promotion path to collapse the engine.search N+1 (one
   *  stats query per cold hit) into a single query. */
  async getColdEntryStatsMany(
    ids: string[],
  ): Promise<Map<string, { hits: number; idleDays: number }>> {
    const out = new Map<string, { hits: number; idleDays: number }>();
    if (ids.length === 0) return out;
    const idleDays = sql<number>`EXTRACT(EPOCH FROM (now() - ${schema.memoryAccess.lastAccessed})) / 86400.0`;
    const rows = await this.db
      .select({
        entryId: schema.memoryAccess.entryId,
        hits: schema.memoryAccess.hits,
        idleDays,
      })
      .from(schema.memoryAccess)
      .where(inArray(schema.memoryAccess.entryId, ids));
    for (const r of rows) {
      out.set(r.entryId, { hits: Number(r.hits), idleDays: Number(r.idleDays) });
    }
    return out;
  }

  /** Read the access-count + idle-days for a single entry — used by the
   *  cold→warm promotion path. Returns null when the entry has no access
   *  row at all (shouldn't happen for promotion candidates). */
  async getColdEntryStats(id: string): Promise<{ hits: number; idleDays: number } | null> {
    const idleDays = sql<number>`EXTRACT(EPOCH FROM (now() - ${schema.memoryAccess.lastAccessed})) / 86400.0`;
    const [row] = await this.db
      .select({ hits: schema.memoryAccess.hits, idleDays })
      .from(schema.memoryAccess)
      .where(eq(schema.memoryAccess.entryId, id))
      .limit(1);
    if (!row) return null;
    return { hits: Number(row.hits), idleDays: Number(row.idleDays) };
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
    await this.db
      .insert(schema.memoryRelations)
      .values({ userId, projectId: projectId ?? null, fromId, toId, relation, strength })
      .onConflictDoUpdate({
        target: [
          schema.memoryRelations.fromId,
          schema.memoryRelations.toId,
          schema.memoryRelations.relation,
        ],
        set: { strength },
      });
  }

  async markCold(id: string, cold: boolean): Promise<void> {
    await this.db
      .update(schema.memoryEntries)
      .set({ cold, updatedAt: new Date() })
      .where(eq(schema.memoryEntries.id, id));
  }

  async stats(userId: string) {
    const rows = await this.db
      .select({
        namespace: schema.memoryEntries.namespace,
        cold: schema.memoryEntries.cold,
        count: count(),
      })
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.userId, userId))
      .groupBy(schema.memoryEntries.namespace, schema.memoryEntries.cold);
    const [last] = await this.db
      .select({ finishedAt: schema.decayRuns.finishedAt })
      .from(schema.decayRuns)
      .orderBy(desc(schema.decayRuns.id))
      .limit(1);
    // Caller compares against `count: string` shape; preserve to avoid
    // a wider blast radius. count() returns number from drizzle.
    return {
      rows: rows.map((r) => ({ namespace: r.namespace, cold: r.cold, count: String(r.count) })),
      lastDecayAt: last?.finishedAt ?? null,
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.execute(sql`SELECT 1`);
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
