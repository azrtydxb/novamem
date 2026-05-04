CREATE TABLE IF NOT EXISTS "admin_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"metadata" jsonb,
	"request_ip" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cold_orphans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT 'public' NOT NULL,
	"project_id" text,
	"namespace" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decay_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"demoted" integer DEFAULT 0 NOT NULL,
	"promoted" integer DEFAULT 0 NOT NULL,
	"effective_days" real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_access" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"last_accessed" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT 'public' NOT NULL,
	"project_id" text,
	"content" text NOT NULL,
	"namespace" text DEFAULT 'default' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"agent_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"cold" boolean DEFAULT false NOT NULL,
	"source_type" text,
	"captured_from" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_fts" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"user_id" text DEFAULT 'public' NOT NULL,
	"project_id" text,
	"content" text NOT NULL,
	"namespace" text DEFAULT 'default' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_relations" (
	"user_id" text DEFAULT 'public' NOT NULL,
	"project_id" text,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"relation" text DEFAULT 'co_occurs' NOT NULL,
	"strength" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_relation" UNIQUE("from_id","to_id","relation")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metrics_samples" (
	"user_id" text NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"queries" integer DEFAULT 0 NOT NULL,
	"remembers" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metrics_samples_user_id_sampled_at_pk" PRIMARY KEY("user_id","sampled_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_members" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_project_members" UNIQUE("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_active_project" (
	"user_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_ts" ON "admin_audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_actor" ON "admin_audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orphans_attempts" ON "cold_orphans" USING btree ("attempts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orphans_attempt_lastattempt" ON "cold_orphans" USING btree ("attempts","last_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_access_last" ON "memory_access" USING btree ("last_accessed");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_user" ON "memory_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_project" ON "memory_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_namespace" ON "memory_entries" USING btree ("namespace");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_agent" ON "memory_entries" USING btree ("agent_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_cold" ON "memory_entries" USING btree ("cold");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_source_type" ON "memory_entries" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_confidence" ON "memory_entries" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_content_hash" ON "memory_entries" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_user_cold" ON "memory_entries" USING btree ("user_id","cold");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fts_user" ON "memory_fts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fts_project" ON "memory_fts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fts_namespace" ON "memory_fts" USING btree ("namespace");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fts_entry" ON "memory_fts" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relations_user" ON "memory_relations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relations_project" ON "memory_relations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relations_from" ON "memory_relations" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relations_to" ON "memory_relations" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_metrics_samples_at" ON "metrics_samples" USING btree ("sampled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_owner_user" ON "projects" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_tokens_user" ON "user_tokens" USING btree ("user_id");