-- On-behalf-of service tokens and organization scoping (ADR 0011).
--
-- memory_entries.organization_id: every pre-existing row, and every row
-- an ordinary user writes, belongs to the organization "default". A
-- constant DEFAULT is a catalog-only change on PostgreSQL 11+, so the
-- backfill does not rewrite the table.
--
-- service_keys: the Ed25519 public keys of services allowed to mint
-- on-behalf-of JWTs. Each key is bound to exactly one organization. Only
-- the public half is stored. public_key is the raw 32-byte key, base64url.
ALTER TABLE "memory_entries"
  ADD COLUMN IF NOT EXISTS "organization_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_org_user" ON "memory_entries" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_org_user_cold" ON "memory_entries" USING btree ("organization_id","user_id","cold");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_service_keys_org" ON "service_keys" USING btree ("organization_id");
