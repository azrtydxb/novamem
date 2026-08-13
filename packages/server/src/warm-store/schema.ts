/**
 * Warm-store schema. The product treats *user* as the only first-class
 * memory owner — there is no separate "user" concept. A user's id is
 * their isolation key for memory entries / FTS / graph relations / cold
 * collections. Projects let multiple users share a sub-brain; otherwise
 * memory belongs to exactly one user.
 *
 * The synthetic id `"public"` exists as the implicit owner in
 * `auth.mode = none|bearer` — single-user / dev deployments where no
 * named user has been created yet.
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  serial,
  bigserial,
  integer,
  real,
  boolean,
  timestamp,
  index,
  unique,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

// Note: users + sessions tables — the legacy bcrypt + cookie path —
// were dropped when Better Auth took over the dashboard's user model.
// Better Auth manages its own DDL on the singular `"user"` / `"session"`
// tables, which aren't in this schema (their table definitions live in
// better-auth's package and are applied by Better Auth at boot).
// Foreign keys from user_tokens / projects / project_members were
// converted to free-text references; orphan rows fail-safe at
// resolve time.

/** A project is a sub-brain — memory entries scoped to a coherent body
 *  of work, optionally shared between users. Owned by one user (the
 *  creator); additional members are added via `project_members`. */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_projects_owner_user").on(table.ownerUserId)],
);

/** Membership rows. The owner is also a row here (role='owner') so
 *  listing "my projects" is one query. role values: 'owner' | 'member'. */
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: text("project_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_project_members").on(table.projectId, table.userId),
    index("idx_project_members_user").on(table.userId),
  ],
);

/** One row per provisioned bearer token. A token belongs to exactly one
 *  user — it represents a device or agent that user has authorised to
 *  act on their memory. The bearer grants access to everything the
 *  owning user can reach (global memory + every project they're a
 *  member of); there is no per-token project scope. The plaintext token
 *  is *only* shown at creation; the column stores a sha256 hash so a
 *  leaked DB doesn't equal leaked tokens. */
export const userTokens = pgTable(
  "user_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    label: text("label"),
    /** "full" (everything the user can do) or "read_only" (GET + the
     *  read-shaped POST routes: search/recent/neighbors/context). The
     *  auth hook enforces it; new columns default to the historical
     *  behavior so pre-migration tokens keep working unchanged. */
    scope: text("scope").notNull().default("full"),
    /** When set, the token is confined to this project (ULID): reads and
     *  writes are forced into it, and any restricted token is barred
     *  from /v1/auth/*, token minting and /v1/admin/*. Null = user-wide. */
    projectId: text("project_id"),
    /** Hard expiry. Expired tokens resolve as if revoked (401). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("idx_user_tokens_user").on(table.userId)],
);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().default("public"),
    /** Optional project scope. Null = the user's user-wide entries. */
    projectId: text("project_id"),
    content: text("content").notNull(),
    namespace: text("namespace").notNull().default("default"),
    source: text("source").notNull().default("manual"),
    agentName: text("agent_name"),
    metadata: jsonb("metadata").default({}),
    /** True if this entry is in the cold tier (vectors only). */
    cold: boolean("cold").notNull().default(false),
    /** Provenance: open-string vocabulary describing where the memory
     *  originated (chat / email / code-review / doc / inference / …). */
    sourceType: text("source_type"),
    /** Provenance: operator-defined free-text channel reference. */
    capturedFrom: text("captured_from"),
    /** Provenance: 0..1 confidence; default 1.0. Lower for inferred facts. */
    confidence: real("confidence").notNull().default(1.0),
    /** Sha256 of trimmed content. Powers the exact-duplicate fast-path
     *  in the worthiness gate. */
    contentHash: text("content_hash"),
    /** When this entry's vector was written to the cold store. NULL means
     *  "no vector exists yet" — and that NULL *is* the pending-embedding
     *  queue. Keeping the state on the row rather than in a side table is
     *  what makes it crash-safe: there is no window in which a queue row
     *  and the entry it describes can disagree, and a process killed
     *  between INSERT and embed leaves a row the reconciler will pick up
     *  rather than an entry that is silently unfindable by semantic
     *  search forever. */
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    /** When set, this chunk owes a fact-extraction pass — the durable
     *  twin of the `embedded_at` queue, with the polarity deliberately
     *  inverted (`NOT NULL` = pending). `embedded_at IS NULL` works as a
     *  queue because every entry owes a vector; extraction is owed only
     *  by chunks written while the extractor was enabled. Fact rows must
     *  never re-enter the queue (extraction of an extraction), and a
     *  store upgraded from a pre-column version must not suddenly owe a
     *  pass for every entry ever written. Set at insert time by the
     *  write path, cleared by the extraction worker on completion —
     *  including a completion that legitimately produced zero facts. */
    factsPendingAt: timestamp("facts_pending_at", { withTimezone: true }),
    /** Graph-enrichment debt marker — third clone of the embedded_at /
     *  facts_pending_at pattern (NOT NULL = pending). Set at insert when
     *  the engine owes vector-neighbour edges + entity links; cleared by
     *  the enrichment worker on completion. The write path attempts
     *  enrichment immediately (async, bounded in-flight); when the bound
     *  is hit the attempt is deferred, not skipped — the marker survives
     *  restarts and the reconciler drains it, so no edge is silently
     *  lost the way a fire-and-forget skip would lose it. */
    graphPendingAt: timestamp("graph_pending_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_entries_user").on(table.userId),
    index("idx_entries_project").on(table.projectId),
    index("idx_entries_namespace").on(table.namespace),
    index("idx_entries_agent").on(table.agentName),
    index("idx_entries_cold").on(table.cold),
    index("idx_entries_source_type").on(table.sourceType),
    index("idx_entries_confidence").on(table.confidence),
    index("idx_entries_content_hash").on(table.userId, table.contentHash),
    index("idx_entries_user_cold").on(table.userId, table.cold),
    // Partial index: the reconciler's only query is
    // `WHERE embedded_at IS NULL ORDER BY created_at` and the healthy
    // steady state is zero matching rows. A partial index stays
    // near-empty in that state, so draining a backlog costs an index
    // scan instead of a seq scan over every entry ever written.
    index("idx_entries_pending_embedding")
      .on(table.createdAt)
      .where(sql`${table.embeddedAt} IS NULL`),
    // Same reasoning as the pending-embedding index: the extraction
    // reconciler's only query is `WHERE facts_pending_at IS NOT NULL
    // ORDER BY facts_pending_at`, and the healthy steady state is zero
    // matching rows, so the partial index stays near-empty.
    index("idx_entries_facts_pending")
      .on(table.factsPendingAt)
      .where(sql`${table.factsPendingAt} IS NOT NULL`),
    // Third instance of the pending-marker partial-index reasoning.
    index("idx_entries_graph_pending")
      .on(table.graphPendingAt)
      .where(sql`${table.graphPendingAt} IS NOT NULL`),
  ],
);

export const memoryAccess = pgTable(
  "memory_access",
  {
    entryId: text("entry_id").primaryKey(),
    hits: integer("hits").notNull().default(1),
    lastAccessed: timestamp("last_accessed", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_access_last").on(table.lastAccessed)],
);

export const memoryRelations = pgTable(
  "memory_relations",
  {
    userId: text("user_id").notNull().default("public"),
    projectId: text("project_id"),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    relation: text("relation").notNull().default("co_occurs"),
    strength: real("strength").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Arch-plan Phase 3: bitemporal validity. `valid_from` defaults to
     *  insertion time; `valid_to` NULL means "currently valid". Callers
     *  with `asOf` in /v1/search filter to edges whose interval contains
     *  the requested time. Zep/Graphiti pattern: history-preserving,
     *  contradiction-tolerant. */
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
  },
  (table) => [
    unique("uq_relation").on(table.fromId, table.toId, table.relation),
    index("idx_relations_user").on(table.userId),
    index("idx_relations_project").on(table.projectId),
    index("idx_relations_from").on(table.fromId),
    index("idx_relations_to").on(table.toId),
    index("idx_relations_valid_to").on(table.validTo),
  ],
);

/** FTS shadow table — populated by trigger; tsv lives in raw SQL to
 *  bypass Drizzle's lack of GENERATED-column support. */
export const memoryFts = pgTable(
  "memory_fts",
  {
    id: serial("id").primaryKey(),
    entryId: text("entry_id").notNull(),
    userId: text("user_id").notNull().default("public"),
    projectId: text("project_id"),
    content: text("content").notNull(),
    namespace: text("namespace").notNull().default("default"),
  },
  (table) => [
    index("idx_fts_user").on(table.userId),
    index("idx_fts_project").on(table.projectId),
    index("idx_fts_namespace").on(table.namespace),
    index("idx_fts_entry").on(table.entryId),
  ],
);

export const decayRuns = pgTable("decay_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  demoted: integer("demoted").notNull().default(0),
  promoted: integer("promoted").notNull().default(0),
  effectiveDays: real("effective_days"),
});

/** Small key/value store for background-job state that must survive a
 *  restart. Currently just the dream cycle's table-walk cursor: without
 *  persistence every restart rewound it to the beginning, so a store
 *  larger than one batch would keep re-compacting its oldest rows and
 *  never reach the newer ones. */
export const engineState = pgTable("engine_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cold-tier orphans — entries whose qdrant delete failed; reaper retries
 *  with exponential backoff and gives up after a few attempts. */
export const coldOrphans = pgTable(
  "cold_orphans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().default("public"),
    projectId: text("project_id"),
    namespace: text("namespace").notNull(),
    /** What repair this row needs.
     *
     *  - `delete`  — the warm row is gone but its Qdrant vector survived
     *    (the original orphan case): the reaper retries the delete.
     *  - `backfill` — the warm row exists but its vector was never
     *    written, because the embedder or Qdrant failed *after* the warm
     *    insert committed. Without this the entry stays permanently
     *    invisible to vector search: the content-hash dedup fast-path
     *    short-circuits every retry, so nothing ever re-embeds it. The
     *    reaper re-embeds and upserts instead of deleting.
     *
     *  Defaults to `delete` so rows written before this column existed
     *  keep their original meaning. */
    kind: text("kind").notNull().default("delete"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_orphans_attempts").on(table.attempts),
    index("idx_orphans_attempt_lastattempt").on(table.attempts, table.lastAttemptAt),
  ],
);

/** Per-user "current sub-brain" pointer. When set, memory.* calls without
 *  an explicit project arg default to this project. One row per user;
 *  deactivate = delete the row. */
export const userActiveProject = pgTable("user_active_project", {
  userId: text("user_id").primaryKey(),
  projectId: text("project_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Audit trail of admin actions (user CRUD, role changes, project deletes,
 *  …). Append-only — no UPDATE / DELETE paths. */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text("actor_user_id"),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata"),
    requestIp: text("request_ip"),
  },
  (table) => [
    index("idx_audit_ts").on(table.ts),
    index("idx_audit_actor").on(table.actorUserId),
  ],
);

/** Persistent throughput history — one row per user per minute, written
 *  by a per-minute flush from the in-memory MetricsCollector. Powers the
 *  24h history chart on the user dashboard. */
export const metricsSamples = pgTable(
  "metrics_samples",
  {
    userId: text("user_id").notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    queries: integer("queries").notNull().default(0),
    remembers: integer("remembers").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.sampledAt] }),
    index("idx_metrics_samples_at").on(table.sampledAt),
  ],
);

/** Append-only per-user changelog — what happened to my memory since T?
 *  Written best-effort on every mutation (created / updated / superseded /
 *  deleted / expired) and pruned on the decay timer. Lets an orchestrator
 *  audit what capture, supersession and the reapers did to an agent's
 *  memory without polling full listings. */
export const memoryChanges = pgTable(
  "memory_changes",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    userId: text("user_id").notNull(),
    projectId: text("project_id"),
    entryId: text("entry_id").notNull(),
    change: text("change").notNull(),
    detail: jsonb("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_memory_changes_user_at").on(table.userId, table.at)],
);

/** Per-user quota overrides (admin-set). NULL columns fall back to the
 *  server-wide defaults (NOVAMEM_QUOTA_* env). Absent row = defaults. */
export const userQuotas = pgTable("user_quotas", {
  userId: text("user_id").primaryKey(),
  /** Hard cap on stored entries (any scope). NULL = server default. */
  maxEntries: integer("max_entries"),
  /** Write-rate cap (remember/capture per minute). NULL = server default. */
  writesPerMinute: integer("writes_per_minute"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
