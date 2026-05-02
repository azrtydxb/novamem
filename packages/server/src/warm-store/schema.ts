/**
 * Warm-store schema. Only the genuinely portable memory primitives — domain
 * tables (tasks, users, projects, etc.) belong to the consuming application.
 */

import {
  pgTable,
  text,
  serial,
  integer,
  real,
  boolean,
  timestamp,
  index,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";

/** Tenants own all memory entries; isolation is enforced server-side at every
 *  read and write. The synthetic id `"public"` exists for back-compat /
 *  single-tenant deployments running in `auth.mode = none|bearer`. */
export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Dashboard users. `admin` users see everything; `user` rows are scoped to
 *  one tenant (their token operations and metrics views are filtered to that
 *  tenant only). Tenant-id is null for admins (they aren't bound to one).
 *  Passwords are bcrypt-hashed; never stored or transmitted in plaintext. */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"),
    /** Required for `role = 'user'`; null for admins. */
    tenantId: text("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_users_username").on(table.username),
    index("idx_users_tenant").on(table.tenantId),
  ],
);

/** A project is a sub-brain — memory entries scoped to a coherent body of
 *  work. Owned by one user (the creator), with additional members allowed
 *  via `project_members`. Cross-tenant membership is permitted: that's the
 *  sharing story. The owner_tenant_id stays for billing/quota attribution
 *  even if the owner moves tenants. */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    ownerTenantId: text("owner_tenant_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_projects_owner_user").on(table.ownerUserId),
    index("idx_projects_owner_tenant").on(table.ownerTenantId),
  ],
);

/** Membership rows. The owner is also a row here (role='owner') so listing
 *  "my projects" is one query. role values: 'owner' | 'member'. */
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

/** Session bearer tokens for the dashboard. The plaintext session token is
 *  returned exactly once at login; only the sha256 hash is stored. Sessions
 *  expire after 24h of inactivity by default. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("idx_sessions_user").on(table.userId)],
);

/** One row per provisioned bearer token. The plaintext token is *only* shown
 *  at creation; the column stores a sha256 hash so a leaked DB doesn't equal
 *  leaked tokens. Token format is high-entropy random (256 bits), so a salt
 *  isn't useful — sha256 is fast and sufficient for non-password material. */
export const tenantTokens = pgTable(
  "tenant_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    label: text("label"),
    /** User who minted this token. Null for tokens minted before the user
     *  system existed, or via the legacy admin-token API. */
    createdByUserId: text("created_by_user_id"),
    /** Optional project scope: when set, this token can only see/write
     *  entries belonging to this project. Null = tenant-wide token (legacy). */
    projectId: text("project_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_tokens_tenant").on(table.tenantId),
    index("idx_tokens_creator").on(table.createdByUserId),
    index("idx_tokens_project").on(table.projectId),
  ],
);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("public"),
    /** Optional project scope. Null = tenant-wide (legacy / no project). */
    projectId: text("project_id"),
    content: text("content").notNull(),
    namespace: text("namespace").notNull().default("default"),
    source: text("source").notNull().default("manual"),
    agentName: text("agent_name"),
    metadata: jsonb("metadata").default({}),
    /** True if this entry is in the cold tier (vectors only). */
    cold: boolean("cold").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_entries_tenant").on(table.tenantId),
    index("idx_entries_project").on(table.projectId),
    index("idx_entries_namespace").on(table.namespace),
    index("idx_entries_agent").on(table.agentName),
    index("idx_entries_cold").on(table.cold),
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
    tenantId: text("tenant_id").notNull().default("public"),
    projectId: text("project_id"),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    relation: text("relation").notNull().default("co_occurs"),
    strength: real("strength").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_relation").on(table.fromId, table.toId, table.relation),
    index("idx_relations_tenant").on(table.tenantId),
    index("idx_relations_project").on(table.projectId),
    index("idx_relations_from").on(table.fromId),
    index("idx_relations_to").on(table.toId),
  ],
);

/** FTS shadow table — populated by trigger; tsv lives in raw SQL to bypass
 *  Drizzle's lack of GENERATED-column support. */
export const memoryFts = pgTable(
  "memory_fts",
  {
    id: serial("id").primaryKey(),
    entryId: text("entry_id").notNull(),
    tenantId: text("tenant_id").notNull().default("public"),
    projectId: text("project_id"),
    content: text("content").notNull(),
    namespace: text("namespace").notNull().default("default"),
  },
  (table) => [
    index("idx_fts_tenant").on(table.tenantId),
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
