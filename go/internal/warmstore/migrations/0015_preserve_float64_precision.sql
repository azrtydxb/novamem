-- Go stores these values as float64; PostgreSQL real rounds them to 32 bits.
-- ALTER TYPE may rewrite each table and holds ACCESS EXCLUSIVE while doing so.
ALTER TABLE "decay_runs" ALTER COLUMN "effective_days" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "memory_entries" ALTER COLUMN "confidence" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "memory_relations" ALTER COLUMN "strength" TYPE double precision;
