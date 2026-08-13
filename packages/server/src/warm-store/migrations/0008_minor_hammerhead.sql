CREATE TABLE "user_quotas" (
	"user_id" text PRIMARY KEY NOT NULL,
	"max_entries" integer,
	"writes_per_minute" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
