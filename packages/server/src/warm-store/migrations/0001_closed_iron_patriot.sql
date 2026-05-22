ALTER TABLE "memory_relations" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_relations_valid_to" ON "memory_relations" USING btree ("valid_to");