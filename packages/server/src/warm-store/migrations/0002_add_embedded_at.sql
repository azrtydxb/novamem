ALTER TABLE "memory_entries" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
-- Backfill before the partial index is built, so the index is created over
-- the (empty) pending set rather than over every row that has ever existed.
-- Every pre-existing row is declared already-embedded: the alternative is a
-- day-one reconciler pass that re-embeds the entire corpus, which would cost
-- one embedder call per entry and buy nothing for the rows that do have a
-- vector. CAVEAT: this also marks the entries written during the embedder
-- outage as embedded, because the row carries no evidence either way — see
-- the note in the accompanying change description for how to re-queue a
-- known-bad window by hand.
UPDATE "memory_entries" SET "embedded_at" = "created_at" WHERE "embedded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_entries_pending_embedding" ON "memory_entries" USING btree ("created_at") WHERE "memory_entries"."embedded_at" IS NULL;
