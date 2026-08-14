ALTER TABLE "user_tokens" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD COLUMN "expires_at" timestamp with time zone;