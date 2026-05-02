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

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
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
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    relation: text("relation").notNull().default("co_occurs"),
    strength: real("strength").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_relation").on(table.fromId, table.toId, table.relation),
    index("idx_relations_from").on(table.fromId),
    index("idx_relations_to").on(table.toId),
  ],
);

export const webCache = pgTable(
  "web_cache",
  {
    id: text("id").primaryKey(),
    queryHash: text("query_hash").notNull(),
    query: text("query").notNull(),
    payload: jsonb("payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_webcache_hash").on(table.queryHash),
    index("idx_webcache_expires").on(table.expiresAt),
  ],
);

/** FTS shadow table — populated by trigger; tsv lives in raw SQL to bypass
 *  Drizzle's lack of GENERATED-column support. */
export const memoryFts = pgTable(
  "memory_fts",
  {
    id: serial("id").primaryKey(),
    entryId: text("entry_id").notNull(),
    content: text("content").notNull(),
    namespace: text("namespace").notNull().default("default"),
  },
  (table) => [
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
