-- Forget by source reference (#338).
--
-- An entry can derive from several sources (a document, a ticket, a
-- thread), and a source can feed many entries, so the relation is
-- many-to-many and lives in its own table rather than in a column on
-- memory_entries (a text[] column would force a GIN index on the hottest
-- table and rewrite the whole row on every ref merge).
--
-- ON DELETE CASCADE is the safety net: every existing delete path (forget,
-- project delete, TTL reaper, GDPR user delete) removes the refs with the
-- entry, so a deleted entry can never leave a ref behind.
--
-- organization_id is copied from the entry so the lookup index leads with
-- it and a ref in one organization can never match a forget in another
-- (ADR 0011).
CREATE TABLE IF NOT EXISTS "memory_entry_source_refs" (
	"entry_id" text NOT NULL,
	"organization_id" text DEFAULT 'default' NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entry_source_refs_pk" PRIMARY KEY("entry_id","source_ref"),
	CONSTRAINT "memory_entry_source_refs_entry_fk" FOREIGN KEY ("entry_id") REFERENCES "memory_entries"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_source_refs_org_ref" ON "memory_entry_source_refs" USING btree ("organization_id","source_ref");
