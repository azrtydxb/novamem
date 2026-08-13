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
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
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

/** Minimum time between `last_used_at` touches for one token. Dormancy
 *  reporting needs day-level resolution; one minute keeps the dashboard
 *  effectively live while capping the write rate per token. */
const TOKEN_TOUCH_INTERVAL_MS = 60_000;

/** Cap on the per-process touch-throttle map — reset wholesale past this
 *  size so stale entries (revoked/deleted tokens) can't grow unbounded. */
const TOKEN_TOUCH_MAP_MAX = 10_000;

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

  /** Per-token timestamp of the last queued `last_used_at` touch — the
   *  process-local half of the resolveUserToken write throttle. Bounded
   *  by the number of distinct live tokens this replica sees. */
  private readonly tokenTouchQueuedAt = new Map<string, number>();

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
    // Partial unique index backing the content-hash dedup fast-path.
    // Without it, `findByContentHash` → `insertEntry` is check-then-act:
    // two concurrent identical writes both miss the lookup and both
    // insert. With it, the loser hits ON CONFLICT and adopts the winner's
    // id. COALESCE because NULL project_id (user-global entries) would
    // otherwise never collide with itself under SQL NULL semantics.
    //
    // Best-effort: a database that already accumulated duplicates from
    // the racy era cannot build this index. That is not a reason to
    // refuse to boot — the dedup lookup still works, it is just racy —
    // so we log the conflict and carry on. `novamem-admin dedup` (or a
    // dream cycle pass) collapses the duplicates, after which a restart
    // creates the index.
    try {
      await this.pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_content_hash_scope
           ON memory_entries (user_id, COALESCE(project_id, ''), content_hash)
         WHERE content_hash IS NOT NULL`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[warm-store] could not create idx_entries_content_hash_scope (pre-existing duplicate ` +
          `content hashes?): ${(err as Error).message}. Exact-duplicate writes remain racy until ` +
          `the duplicates are collapsed and the service restarts.`,
      );
    }
  }


  // ─── Tokens ───────────────────────────────────────────────────────────

  /** Mint a new bearer token for a user. Returns the **plaintext** token —
   *  the caller is responsible for getting it to their device; the server
   *  keeps only the sha256 hash. By default the bearer grants everything
   *  the owning user can reach; `opts` narrows it: scope "read_only"
   *  (GET + read-shaped POSTs only), projectId (confined to one project),
   *  expiresAt (hard expiry, resolves as revoked after). Returns null
   *  if the user doesn't exist. */
  async createUserToken(
    userId: string,
    label?: string,
    opts: {
      scope?: "full" | "read_only";
      projectId?: string | null;
      expiresAt?: Date | null;
    } | null = {},
  ): Promise<{ token: string; userId: string; createdAt: Date } | null> {
    // Legacy call sites passed a positional `null` projectId here —
    // treat it as "no options" rather than crashing on property access.
    const o = opts ?? {};
    // Raw: Better-Auth-owned `"user"` table not in our drizzle schema (rule a).
    const exists = await this.db.execute<{ exists: number }>(
      sql`SELECT 1 AS exists FROM "user" WHERE id = ${userId} LIMIT 1`,
    );
    if (exists.rowCount === 0) return null;
    const token = generateBearerToken();
    const tokenHash = hashToken(token);
    const [row] = await this.db
      .insert(schema.userTokens)
      .values({
        tokenHash,
        userId,
        label: label ?? null,
        scope: o.scope ?? "full",
        projectId: o.projectId ?? null,
        expiresAt: o.expiresAt ?? null,
      })
      .returning({ createdAt: schema.userTokens.createdAt });
    return { token, userId, createdAt: row!.createdAt };
  }

  /** Resolve a plaintext bearer token to its user id. Touches `last_used_at`
   *  on success so dormant tokens are visible to operators. Returns null on
   *  unknown or revoked tokens — never throw, the auth hook decides what 4xx
   *  to send.
   *
   *  The resolve itself is a plain SELECT. The old UPDATE…RETURNING form
   *  put a row write on every authenticated request, and concurrent
   *  requests carrying the same token serialized on that row's lock:
   *  measured on the bench corpus at 8 concurrent search workers, p50
   *  went 242→742ms and p95 478→1417ms; at 1 worker the cost vanished.
   *  `last_used_at` is operator telemetry ("is this token dormant?"), so
   *  minute-granularity is plenty: the touch is throttled to once per
   *  TOKEN_TOUCH_INTERVAL_MS per token and fired off-path. */
  async resolveUserToken(
    plaintext: string,
  ): Promise<{
    userId: string;
    tokenHash: string;
    label: string | null;
    scope: "full" | "read_only";
    projectId: string | null;
  } | null> {
    if (!plaintext) return null;
    const tokenHash = hashToken(plaintext);
    const rows = await this.db
      .select({
        userId: schema.userTokens.userId,
        label: schema.userTokens.label,
        scope: schema.userTokens.scope,
        projectId: schema.userTokens.projectId,
        expiresAt: schema.userTokens.expiresAt,
        lastUsedAt: schema.userTokens.lastUsedAt,
      })
      .from(schema.userTokens)
      .where(and(eq(schema.userTokens.tokenHash, tokenHash), isNull(schema.userTokens.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // Expired ⇒ same answer as revoked: null, and the auth hook 401s.
    // Checked in process rather than in SQL so the comparison uses one
    // clock consistently with the touch throttle below.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    const now = Date.now();
    const staleEnough =
      !row.lastUsedAt || now - row.lastUsedAt.getTime() >= TOKEN_TOUCH_INTERVAL_MS;
    const lastQueued = this.tokenTouchQueuedAt.get(tokenHash) ?? 0;
    if (staleEnough && now - lastQueued >= TOKEN_TOUCH_INTERVAL_MS) {
      // Per-process throttle so a burst doesn't queue N identical writes
      // before the first one lands. Off-path: auth never waits on it.
      // Bound the map: entries for revoked/deleted tokens would otherwise
      // accumulate forever. Clearing wholesale is fine — worst case is one
      // extra touch per live token.
      if (this.tokenTouchQueuedAt.size >= TOKEN_TOUCH_MAP_MAX) {
        this.tokenTouchQueuedAt.clear();
      }
      this.tokenTouchQueuedAt.set(tokenHash, now);
      void this.db
        .update(schema.userTokens)
        .set({ lastUsedAt: sql`now()` })
        // Re-check revocation: the token may have been revoked between the
        // SELECT above and this off-path write, and a revoked token must
        // not look freshly used to operators.
        .where(and(eq(schema.userTokens.tokenHash, tokenHash), isNull(schema.userTokens.revokedAt)))
        .catch(() => {
          // Telemetry write — losing one touch is harmless; allow a retry.
          this.tokenTouchQueuedAt.delete(tokenHash);
        });
    }
    return {
      userId: row.userId,
      tokenHash,
      label: row.label,
      scope: (row.scope === "read_only" ? "read_only" : "full") as "full" | "read_only",
      projectId: row.projectId,
    };
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
      .where(this.visibleMemoryWhere(userId));
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
      scope: string;
      projectId: string | null;
      expiresAt: Date | null;
      createdAt: Date;
      lastUsedAt: Date | null;
      revoked: boolean;
    }>
  > {
    const rows = await this.db
      .select({
        tokenHash: schema.userTokens.tokenHash,
        label: schema.userTokens.label,
        scope: schema.userTokens.scope,
        projectId: schema.userTokens.projectId,
        expiresAt: schema.userTokens.expiresAt,
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
      scope: r.scope,
      projectId: r.projectId,
      expiresAt: r.expiresAt,
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
        .returning({
          userId: schema.userTokens.userId,
          scope: schema.userTokens.scope,
          projectId: schema.userTokens.projectId,
          expiresAt: schema.userTokens.expiresAt,
        });
      const old = revoked[0];
      const userId = old?.userId;
      if (!old || !userId) return null;
      const token = generateBearerToken();
      const tokenHash = hashToken(token);
      // Rotation preserves the old token's restrictions verbatim —
      // otherwise rotating a read-only or project-confined bearer would
      // quietly mint an unrestricted one (privilege escalation via the
      // one endpoint restricted tokens used to be able to reach).
      const [inserted] = await tx
        .insert(schema.userTokens)
        .values({
          tokenHash,
          userId,
          label: "rotated",
          scope: old.scope,
          projectId: old.projectId,
          expiresAt: old.expiresAt,
        })
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

  /** Admin listing of every user with their footprint (entry + token
   *  counts) — the census an operator needs before deciding to remove
   *  one. Counts are per-owner, regardless of project. */
  async listUsers(): Promise<
    Array<{
      id: string;
      email: string;
      name: string;
      role: string;
      createdAt: Date;
      entryCount: number;
      tokenCount: number;
    }>
  > {
    const r = await this.db.execute<{
      id: string;
      email: string;
      name: string;
      role: string | null;
      created_at: Date;
      entry_count: string;
      token_count: string;
    }>(sql`
      SELECT u.id, u.email, u.name, u.role, u."createdAt" AS created_at,
             (SELECT count(*) FROM memory_entries e WHERE e.user_id = u.id) AS entry_count,
             (SELECT count(*) FROM user_tokens t
               WHERE t.user_id = u.id AND t.revoked_at IS NULL
                 AND (t.expires_at IS NULL OR t.expires_at > now())) AS token_count
        FROM "user" u
       ORDER BY u."createdAt" ASC
    `);
    return r.rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role ?? "user",
      createdAt: row.created_at,
      entryCount: Number(row.entry_count),
      tokenCount: Number(row.token_count),
    }));
  }

  /** Owned-project ids for a user — the engine deletes these first (via
   *  deleteProject, which also drops their cold collections) before
   *  calling deleteUserData for the user-global remainder. */
  async listOwnedProjects(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerUserId, userId));
    return rows.map((r) => r.id);
  }

  /** Remove EVERYTHING the warm store holds for a user: memories (in any
   *  remaining scope), FTS rows, relations, access telemetry, orphan
   *  queue rows, project memberships, tokens, Better Auth sessions,
   *  accounts and the user row itself. One transaction — a half-deleted
   *  user is worse than a present one. Owned projects must already be
   *  gone (engine's job); this method refuses if any remain, because
   *  deleting the owner row first would orphan them. */
  async deleteUserData(
    userId: string,
  ): Promise<{ deleted: boolean; entriesRemoved: number; tokensRemoved: number; reason?: string }> {
    const owned = await this.listOwnedProjects(userId);
    if (owned.length > 0) {
      return {
        deleted: false,
        entriesRemoved: 0,
        tokensRemoved: 0,
        reason: `user still owns ${owned.length} project(s)`,
      };
    }
    return this.db.transaction(async (tx) => {
      // Vectors this user wrote into OTHER users' projects can't be
      // reached by the Qdrant store's collection-level deleteAllForUser
      // (owned projects are already gone by contract). Park their ids in
      // cold_orphans so the reaper deletes them point-by-point; on the
      // pgvector backend deleteAllForUser removes them directly and the
      // orphan rows clear as no-ops.
      await tx.execute(sql`
        INSERT INTO cold_orphans (id, user_id, namespace, project_id, attempts, last_error, last_attempt_at)
        SELECT id, user_id, namespace, project_id, 0, 'user teardown', NULL
          FROM memory_entries
         WHERE user_id = ${userId} AND project_id IS NOT NULL
        ON CONFLICT (id) DO NOTHING
      `);
      await tx.execute(sql`
        DELETE FROM memory_access WHERE entry_id IN (
          SELECT id FROM memory_entries WHERE user_id = ${userId}
        )
      `);
      await tx.delete(schema.memoryFts).where(eq(schema.memoryFts.userId, userId));
      await tx.delete(schema.memoryRelations).where(eq(schema.memoryRelations.userId, userId));
      const removed = await tx
        .delete(schema.memoryEntries)
        .where(eq(schema.memoryEntries.userId, userId))
        .returning({ id: schema.memoryEntries.id });
      await tx.delete(schema.coldOrphans).where(eq(schema.coldOrphans.userId, userId));
      await tx.delete(schema.projectMembers).where(eq(schema.projectMembers.userId, userId));
      await tx.delete(schema.userActiveProject).where(eq(schema.userActiveProject.userId, userId));
      const tokens = await tx
        .delete(schema.userTokens)
        .where(eq(schema.userTokens.userId, userId))
        .returning({ tokenHash: schema.userTokens.tokenHash });
      // Per-user telemetry — part of "everything the warm store holds".
      await tx.execute(sql`DELETE FROM metrics_samples WHERE user_id = ${userId}`);
      // Better Auth's tables aren't in the drizzle schema (rule a) —
      // delete sessions and credential accounts before the user row.
      await tx.execute(sql`DELETE FROM session WHERE "userId" = ${userId}`);
      await tx.execute(sql`DELETE FROM account WHERE "userId" = ${userId}`);
      await tx.execute(sql`DELETE FROM "user" WHERE id = ${userId}`);
      return { deleted: true, entriesRemoved: removed.length, tokensRemoved: tokens.length };
    });
  }

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
    /** Set when this chunk owes a fact-extraction pass. Written in the
     *  same transaction as the row so a crash between INSERT and the
     *  extraction schedule leaves work the reconciler finds, never a
     *  chunk whose facts are silently owed by nobody. */
    factsPendingAt?: Date | null;
    graphPendingAt?: Date | null;
  }): Promise<string> {
    const id = ulid();
    // All three rows in one transaction. Previously these were three
    // independent statements: a crash (or a connection drop) between the
    // entry insert and the FTS insert left a memory that keyword search
    // could never see again, with nothing to repair it.
    //
    // `onConflictDoNothing` on the entry insert closes the check-then-act
    // race in the caller's dedup fast-path (`findByContentHash` then
    // insert): two concurrent identical writes both miss the lookup, and
    // the partial unique index created in `ensureFtsExtras` makes the
    // loser land here instead of creating a duplicate row.
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.memoryEntries)
        .values({
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
          factsPendingAt: args.factsPendingAt ?? null,
          graphPendingAt: args.graphPendingAt ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.memoryEntries.id });
      const winner = inserted[0]?.id;
      if (!winner) {
        // Lost the race — a concurrent writer already stored this exact
        // content in this scope. Return their id; the caller treats it as
        // a dedup hit, which is what a sequential run would have produced.
        // Match the hash the way SQL actually treats it. Coercing a null
        // hash to "" would compare against a value no row can hold, so
        // the lookup would miss and this path would throw even when the
        // conflicting row exists. Today the partial unique index is
        // `WHERE content_hash IS NOT NULL`, so a null-hash insert can
        // only conflict on the primary key — but writing it correctly
        // costs nothing and stops the guard being wrong by construction
        // if the index or a caller ever changes.
        const [existing] = await tx
          .select({ id: schema.memoryEntries.id })
          .from(schema.memoryEntries)
          .where(
            and(
              eq(schema.memoryEntries.userId, args.userId),
              args.contentHash == null
                ? isNull(schema.memoryEntries.contentHash)
                : eq(schema.memoryEntries.contentHash, args.contentHash),
              args.projectId == null
                ? isNull(schema.memoryEntries.projectId)
                : eq(schema.memoryEntries.projectId, args.projectId),
            ),
          )
          .limit(1);
        if (existing?.id) return existing.id;
        throw new Error("insertEntry: conflict with no resolvable existing row");
      }
      await tx.insert(schema.memoryFts).values({
        entryId: winner,
        userId: args.userId,
        projectId: args.projectId ?? null,
        content: args.content,
        namespace: args.namespace,
      });
      await tx.insert(schema.memoryAccess).values({ entryId: winner });
      return winner;
    });
  }

  /** Read a persisted background-job state value, or null when unset. */
  async getEngineState(key: string): Promise<string | null> {
    const [row] = await this.db
      .select({ value: schema.engineState.value })
      .from(schema.engineState)
      .where(eq(schema.engineState.key, key))
      .limit(1);
    return row?.value ?? null;
  }

  /** Persist a background-job state value. */
  async setEngineState(key: string, value: string): Promise<void> {
    await this.db
      .insert(schema.engineState)
      .values({ key, value })
      .onConflictDoUpdate({
        target: schema.engineState.key,
        set: { value, updatedAt: sql`now()` },
      });
  }

  /** Queue a warm entry whose cold vector is missing, so the reaper can
   *  re-embed it. The mirror of the `delete`-kind orphan rows written by
   *  `engine.forget()` when a Qdrant delete fails: this side covers the
   *  case where a Qdrant *write* failed after the warm row committed. */
  async recordMissingVector(args: {
    userId: string;
    projectId: string | null;
    entryId: string;
    namespace: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO cold_orphans (id, user_id, namespace, project_id, kind, attempts, last_attempt_at)
       VALUES ($1, $2, $3, $4, 'backfill', 0, NULL)
       ON CONFLICT (id) DO UPDATE SET
         kind = 'backfill',
         namespace = EXCLUDED.namespace,
         project_id = EXCLUDED.project_id`,
      [args.entryId, args.userId, args.namespace, args.projectId],
    );
  }

  /** Drop a backfill row once the vector is present again. */
  async clearMissingVector(entryId: string): Promise<void> {
    await this.pool.query(`DELETE FROM cold_orphans WHERE id = $1 AND kind = 'backfill'`, [entryId]);
  }

  /** Look up an existing entry by content hash within a user's scope.
   *  Used by the worthiness gate to short-circuit exact duplicates
   *  without re-embedding.
   *
   *  Returns the match's `namespace` alongside its id because the dedup
   *  scope (user, project, hash) deliberately spans namespaces: the hit
   *  may live on a different shelf than the caller is writing to.
   *  Callers that go on to touch namespace-scoped storage must use the
   *  entry's own namespace, not the request's. */
  async findByContentHash(
    userId: string,
    projectId: string | null,
    contentHash: string,
  ): Promise<{ id: string; namespace: string } | null> {
    const [row] = await this.db
      .select({ id: schema.memoryEntries.id, namespace: schema.memoryEntries.namespace })
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
    return row ? { id: row.id, namespace: row.namespace } : null;
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
    // Entry row and FTS shadow move together or not at all — a failure
    // between them would leave keyword search serving the old text while
    // vector search served the new.
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.memoryEntries)
        .set(patch)
        .where(eq(schema.memoryEntries.id, args.id));
      // FTS shadow has its own row keyed by entry_id — refresh content +
      // namespace when they change so keyword search picks up the rewrite.
      if (args.content !== undefined || args.namespace !== undefined) {
        const fPatch: Partial<typeof schema.memoryFts.$inferInsert> = {};
        if (args.content !== undefined) fPatch.content = args.content;
        if (args.namespace !== undefined) fPatch.namespace = args.namespace;
        await tx
          .update(schema.memoryFts)
          .set(fPatch)
          .where(eq(schema.memoryFts.entryId, args.id));
      }
    });
    return true;
  }


  /** Rows visible to the production hygiene report. This is intentionally a
   *  typed store method rather than the engine reaching into FakeWarmStore's
   *  in-memory `rows` map; production uses Postgres and must exercise the
   *  same contract. */
  private visibleMemoryWhere(userId: string) {
    return or(
      and(eq(schema.memoryEntries.userId, userId), isNull(schema.memoryEntries.projectId)),
      sql`EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = ${schema.memoryEntries.projectId}
          AND pm.user_id = ${userId}
      )`,
    );
  }

  async listHygieneEntries(
    userId: string,
    opts: { k?: number } = {},
  ): Promise<Array<{
    id: string;
    userId: string;
    projectId: string | null;
    content: string;
    namespace: string;
    metadata: Record<string, unknown> | null;
  }>> {
    const rows = await this.db
      .select({
        id: schema.memoryEntries.id,
        userId: schema.memoryEntries.userId,
        projectId: schema.memoryEntries.projectId,
        content: schema.memoryEntries.content,
        namespace: schema.memoryEntries.namespace,
        metadata: schema.memoryEntries.metadata,
        updatedAt: schema.memoryEntries.updatedAt,
      })
      .from(schema.memoryEntries)
      .where(this.visibleMemoryWhere(userId))
      .orderBy(desc(schema.memoryEntries.updatedAt))
      .limit(opts.k ?? 400);
    return rows.map((r) => ({ ...r, metadata: (r.metadata ?? null) as Record<string, unknown> | null }));
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
    const nsMatch = useNsArray
      ? inArray(schema.memoryFts.namespace, args.namespaces!)
      : eq(schema.memoryFts.namespace, args.namespace);
    const scopeMatch = isProject
      ? eq(schema.memoryFts.projectId, args.projectId!)
      : and(eq(schema.memoryFts.userId, args.userId), isNull(schema.memoryFts.projectId));

    // ── tsquery construction (AND-then-OR) ────────────────────────────
    // The keyword tier used to build its query with `plainto_tsquery`,
    // which ANDs every lexeme. That is fine for a hand-typed keyword
    // search and actively broken for the way this tier is actually
    // driven: `memory_context` passes the *entire user message* as the
    // query, so a stored fact like "NovaMem runs on port 7778" could
    // never match "what port does the novamem deployment run on in
    // production" — every one of those lexemes had to appear in the same
    // row. In practice the tier returned nothing on the primary grounding
    // path and hybrid search silently collapsed to vector-only.
    //
    // `websearch_to_tsquery` is the modern equivalent and additionally
    // understands quoted phrases and OR/-negation, so power users get
    // operator syntax for free. We still try the strict (AND) form first
    // because when it matches it is the most precise answer; only when it
    // returns nothing do we fall back to the OR form, built by rewriting
    // the parsed tsquery's `&` operators to `|`. Rewriting the *parsed*
    // query (rather than the raw string) keeps stemming, stop-word
    // removal, and phrase operators intact, and keeps the user's text a
    // bound parameter throughout — there is no string interpolation here.
    // ── single-pass strict-preference query ───────────────────────────
    // The tier used to run the strict (AND) form first and fall back to
    // the loose (OR) rewrite only on zero hits. On the primary grounding
    // path (memory_context passes the whole user message) strict nearly
    // always misses, so the common case paid two sequential round trips
    // with the second being the expensive OR ranking. One statement now
    // matches the loose superset once, flags which rows also satisfy the
    // strict form, ranks each row against the form it satisfies, and
    // orders strict-first — then the JS below keeps only strict rows when
    // any exist, which reproduces the old two-query semantics exactly.
    // The user's text stays a bound parameter throughout.
    const nsSql = useNsArray
      ? sql`f.namespace = ANY(${args.namespaces!})`
      : sql`f.namespace = ${args.namespace}`;
    const scopeSql = isProject
      ? sql`f.project_id = ${args.projectId!}`
      : sql`f.user_id = ${args.userId} AND f.project_id IS NULL`;
    const agentSql =
      args.agentName === undefined
        ? sql`TRUE`
        : args.agentName === null
          ? sql`e.agent_name IS NULL`
          : sql`e.agent_name = ${args.agentName}`;
    const joinSql = args.agentName === undefined
      ? sql``
      : sql`JOIN memory_entries e ON e.id = f.entry_id`;

    const res = await this.db.execute(sql`
      WITH q AS (
        SELECT websearch_to_tsquery('english', ${args.query}) AS strict,
               replace(websearch_to_tsquery('english', ${args.query})::text, '&', '|')::tsquery AS loose
      )
      SELECT entry_id, is_strict, score FROM (
        SELECT f.entry_id,
               (f.tsv @@ q.strict) AS is_strict,
               ts_rank_cd(f.tsv, CASE WHEN f.tsv @@ q.strict THEN q.strict ELSE q.loose END) AS score
        FROM memory_fts f ${joinSql}, q
        WHERE ${nsSql} AND ${scopeSql} AND ${agentSql} AND f.tsv @@ q.loose
      ) t
      ORDER BY is_strict DESC, score DESC
      LIMIT ${args.k}
    `);
    const rows = (res.rows as Array<{ entry_id: string; is_strict: boolean; score: unknown }>);
    const anyStrict = rows.length > 0 && rows[0]!.is_strict;
    return rows
      .filter((r) => !anyStrict || r.is_strict)
      .map((r) => ({ id: r.entry_id, score: Number(r.score) }));
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
   *  scope filter. Used by forget/update paths to recheck the actual project
   *  membership before mutation (the regular `getEntry` filters by the
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
  /** Distinct namespaces with entries visible in the given scope. The
   *  isolation boundary is the same as `listRecent`: in project scope a
   *  project member sees every member's entries, so the result is
   *  "namespaces with entries in this scope" — not "namespaces the
   *  caller personally wrote to". Used by engine.search / engine.recent
   *  when the request specifies neither `namespace` nor
   *  `includeNamespaces` — instead of silently defaulting to "default"
   *  (and missing every entry written to a custom namespace), fan out
   *  across the namespaces that actually contain visible data. Scope
   *  semantics:
   *    - includeProjects: user-global ∪ each listed project
   *    - projectId: that project only
   *    - neither: user-global only (no project membership). */
  async listNamespaces(
    userId: string,
    args: {
      projectId?: string | null;
      includeProjects?: string[] | null;
    } = {},
  ): Promise<string[]> {
    const { projectId = null, includeProjects = null } = args;
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
    const rows = await this.db
      .selectDistinct({ namespace: schema.memoryEntries.namespace })
      .from(schema.memoryEntries)
      .where(scopeClause);
    return rows.map((r) => r.namespace);
  }

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
      .where(this.visibleMemoryWhere(userId))
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

  // ─── Pending-embedding queue ──────────────────────────────────────────
  // `memory_entries.embedded_at IS NULL` is the queue. There is no queue
  // table, so a row and its queue state cannot drift apart and a crash
  // between the INSERT and the embedder call leaves work the reconciler
  // finds instead of an entry that is silently absent from vector search.

  /** Stamp (or clear) an entry's embedded marker. `null` re-queues the
   *  entry — used when its content changed but the re-embed failed, since
   *  the vector on file now describes text that no longer exists. */
  async setEmbeddedAt(id: string, at: Date | null): Promise<void> {
    await this.db
      .update(schema.memoryEntries)
      .set({ embeddedAt: at })
      .where(eq(schema.memoryEntries.id, id));
  }

  /** True when the entry already has a vector. Cheap PK lookup — used on
   *  the dedup fast-paths, where the caller returns an id it did not
   *  itself embed and must not claim it is searchable. */
  async isEmbedded(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ embeddedAt: schema.memoryEntries.embeddedAt })
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.id, id))
      .limit(1);
    return row?.embeddedAt != null;
  }

  /** One bounded reconciler batch, oldest first. Oldest-first matters
   *  because a backlog is almost always an outage window: draining in
   *  write order means the gap in semantic search closes from its start
   *  rather than leaving arbitrary holes. */
  async listPendingEmbedding(limit: number): Promise<
    Array<{
      id: string;
      userId: string;
      projectId: string | null;
      content: string;
      namespace: string;
      source: string;
      agentName: string | null;
    }>
  > {
    return this.db
      .select({
        id: schema.memoryEntries.id,
        userId: schema.memoryEntries.userId,
        projectId: schema.memoryEntries.projectId,
        content: schema.memoryEntries.content,
        namespace: schema.memoryEntries.namespace,
        source: schema.memoryEntries.source,
        agentName: schema.memoryEntries.agentName,
      })
      .from(schema.memoryEntries)
      .where(isNull(schema.memoryEntries.embeddedAt))
      .orderBy(asc(schema.memoryEntries.createdAt))
      .limit(limit);
  }

  /** Size of the pending backlog. Feeds the metrics gauge; a number that
   *  stops falling is the alertable signal that the embedder is gone. */
  async countPendingEmbedding(): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(schema.memoryEntries)
      .where(isNull(schema.memoryEntries.embeddedAt));
    return Number(row?.n ?? 0);
  }

  // ─── Pending fact-extraction queue ────────────────────────────────────
  // `facts_pending_at IS NOT NULL` is the queue — polarity inverted from
  // the embedding queue on purpose; see the schema comment. State lives on
  // the row for the same crash-safety reason.

  /** Clear (or re-arm) a chunk's pending-extraction marker. */
  async setFactsPendingAt(id: string, at: Date | null): Promise<void> {
    await this.db
      .update(schema.memoryEntries)
      .set({ factsPendingAt: at })
      .where(eq(schema.memoryEntries.id, id));
  }

  /** One bounded reconciler batch, oldest-marked first, so an outage
   *  window's gap in fact coverage closes from its start. Returns the
   *  fields `storeFactsForChunk` needs to re-run extraction: sensitivity
   *  travels inside metadata, source is the parent provenance. */
  async listPendingFacts(limit: number): Promise<
    Array<{
      id: string;
      userId: string;
      projectId: string | null;
      content: string;
      namespace: string;
      source: string;
      metadata: Record<string, unknown> | null;
    }>
  > {
    // Claim-on-read: re-arm the marker to now() in the same statement
    // that selects the batch, with SKIP LOCKED so replicas racing on the
    // same tick claim DISJOINT rows. Without this every pod fetched the
    // same oldest-N slice, tripled the LLM spend, and the duplicates
    // were only discarded at content-hash time — measured during the
    // Phase 6 drain as a ~3× throughput loss. Re-arming (rather than
    // clearing) keeps the crash contract: a worker that dies mid-batch
    // leaves the marker set, and the row simply comes back once it
    // reaches the front of the oldest-first queue again.
    // CTE keeps the claimed batch deterministically oldest-first:
    // UPDATE ... RETURNING makes no row-order guarantee, so the final
    // SELECT re-orders by the pre-update marker captured in the CTE.
    const res = await this.db.execute(sql`
      WITH claimed AS (
        SELECT id, facts_pending_at AS claimed_at FROM memory_entries
        WHERE facts_pending_at IS NOT NULL
        ORDER BY facts_pending_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ), updated AS (
        UPDATE memory_entries m SET facts_pending_at = now()
        FROM claimed c WHERE m.id = c.id
        RETURNING m.id, m.user_id, m.project_id, m.content, m.namespace, m.source, m.metadata
      )
      SELECT u.* FROM updated u JOIN claimed c ON c.id = u.id
      ORDER BY c.claimed_at ASC
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      projectId: (r.project_id ?? null) as string | null,
      content: r.content as string,
      namespace: r.namespace as string,
      source: r.source as string,
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
    }));
  }

  /** Clear (or re-arm) an entry's pending-enrichment marker. */
  async setGraphPendingAt(id: string, at: Date | null): Promise<void> {
    await this.db
      .update(schema.memoryEntries)
      .set({ graphPendingAt: at })
      .where(eq(schema.memoryEntries.id, id));
  }

  /** One bounded enrichment-reconciler batch, oldest-marked first. The
   *  worker re-embeds content (the vector is not stored warm-side), so
   *  only the fields linkVectorNeighbors needs come back. */
  async listPendingEnrichment(limit: number): Promise<
    Array<{
      id: string;
      userId: string;
      projectId: string | null;
      content: string;
      namespace: string;
    }>
  > {
    // Same claim-on-read + SKIP LOCKED discipline as listPendingFacts —
    // see the comment there.
    const res = await this.db.execute(sql`
      WITH claimed AS (
        SELECT id, graph_pending_at AS claimed_at FROM memory_entries
        WHERE graph_pending_at IS NOT NULL
        ORDER BY graph_pending_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ), updated AS (
        UPDATE memory_entries m SET graph_pending_at = now()
        FROM claimed c WHERE m.id = c.id
        RETURNING m.id, m.user_id, m.project_id, m.content, m.namespace
      )
      SELECT u.* FROM updated u JOIN claimed c ON c.id = u.id
      ORDER BY c.claimed_at ASC
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      projectId: (r.project_id ?? null) as string | null,
      content: r.content as string,
      namespace: r.namespace as string,
    }));
  }

  /** Size of the pending-enrichment backlog. */
  async countPendingEnrichment(): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(schema.memoryEntries)
      .where(isNotNull(schema.memoryEntries.graphPendingAt));
    return Number(row?.n ?? 0);
  }

  /** Size of the pending-extraction backlog. A number that stops falling
   *  while the extraction endpoint is up is the alertable signal. */
  async countPendingFacts(): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(schema.memoryEntries)
      .where(isNotNull(schema.memoryEntries.factsPendingAt));
    return Number(row?.n ?? 0);
  }

  /** Graph-style neighbourhood traversal over `memory_relations` —
   *  Phase 7: this is what FalkorDB used to answer. Undirected, depth
   *  1..3, score = MAX over paths of the product of edge strengths
   *  (identical semantics to the old Cypher: depth-1 reduces to
   *  MAX(strength)). Bitemporal: with `asOfMs`, only edges valid at that
   *  instant are followed; otherwise only currently-valid edges
   *  (valid_to IS NULL) are. Scope: edges are stored per (user,
   *  project); `projectId` null = user-global. */
  async neighborsByRelations(
    userId: string,
    seedId: string,
    depth: number,
    limit: number,
    projectId: string | null,
    asOfMs: number | null = null,
  ): Promise<Array<{ id: string; score: number }>> {
    const d = Math.max(1, Math.min(3, Math.trunc(depth)));
    const lim = Math.max(1, Math.min(200, Math.trunc(limit)));
    const validity = asOfMs === null
      ? sql`valid_to IS NULL`
      : sql`valid_from <= to_timestamp(${asOfMs / 1000}) AND (valid_to IS NULL OR valid_to >= to_timestamp(${asOfMs / 1000}))`;
    const scope = projectId === null ? sql`project_id IS NULL` : sql`project_id = ${projectId}`;
    const res = await this.db.execute(sql`
      WITH RECURSIVE edges AS (
        SELECT from_id, to_id, strength FROM memory_relations
        WHERE user_id = ${userId} AND ${scope} AND ${validity}
        UNION ALL
        SELECT to_id AS from_id, from_id AS to_id, strength FROM memory_relations
        WHERE user_id = ${userId} AND ${scope} AND ${validity}
      ), walk AS (
        SELECT e.to_id AS id, e.strength::float8 AS score, 1 AS hop,
               ARRAY[${seedId}::text, e.to_id] AS path
        FROM edges e WHERE e.from_id = ${seedId}
        UNION ALL
        SELECT e.to_id, (w.score * e.strength)::float8, w.hop + 1,
               w.path || e.to_id
        FROM walk w JOIN edges e ON e.from_id = w.id
        WHERE w.hop < ${d} AND NOT e.to_id = ANY(w.path)
      )
      SELECT id, MAX(score) AS score FROM walk
      WHERE id <> ${seedId}
      GROUP BY id
      ORDER BY score DESC
      LIMIT ${lim}
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      score: Number(r.score),
    }));
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
