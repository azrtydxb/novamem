ALTER TABLE "memory_entries" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
-- Backfill, hand-written: drizzle-kit cannot know this and will not generate it.
-- `embedded_at IS NULL` is the pending-embedding queue the reconciler drains.
-- Every row that already exists when this migration runs was written by a
-- build that embedded synchronously on the write path, so it already has its
-- vector; leaving it NULL would enqueue the entire corpus and make the
-- reconciler re-embed everything for no benefit. Stamp them as done.
--
-- CAVEAT: this also marks as done any rows that were written during a past
-- embedder outage and genuinely have no vector. The two are indistinguishable
-- in the data at this point — nothing recorded the outage. If the operator
-- knows the window, NULL those rows afterwards and the reconciler will pick
-- them up on its next tick, e.g.:
--   UPDATE "memory_entries" SET "embedded_at" = NULL
--    WHERE "created_at" >= '<outage start>' AND "created_at" < '<outage end>';
-- Must run before the partial index below so the index is built over the
-- final (near-empty) predicate set rather than every row in the table.
UPDATE "memory_entries" SET "embedded_at" = "created_at" WHERE "embedded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_entries_pending_embedding" ON "memory_entries" USING btree ("created_at") WHERE "memory_entries"."embedded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_relations_valid_to" ON "memory_relations" USING btree ("valid_to");
