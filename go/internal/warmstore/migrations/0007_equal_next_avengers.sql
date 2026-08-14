CREATE TABLE "memory_changes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"entry_id" text NOT NULL,
	"change" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_memory_changes_user_at" ON "memory_changes" USING btree ("user_id","at");