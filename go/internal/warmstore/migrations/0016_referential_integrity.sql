-- Keep legacy orphan rows in place and report their counts before adding
-- constraints. NOT VALID avoids scanning existing tables in this transaction;
-- new writes are checked immediately and the migrator validates after commit.
DO $$
DECLARE
	orphan_count bigint;
BEGIN
	SELECT count(*) INTO orphan_count FROM memory_access c LEFT JOIN memory_entries p ON p.id = c.entry_id WHERE p.id IS NULL;
	RAISE NOTICE 'memory_access.entry_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM memory_fts c LEFT JOIN memory_entries p ON p.id = c.entry_id WHERE p.id IS NULL;
	RAISE NOTICE 'memory_fts.entry_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM memory_relations c LEFT JOIN memory_entries p ON p.id = c.from_id WHERE p.id IS NULL;
	RAISE NOTICE 'memory_relations.from_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM memory_relations c LEFT JOIN memory_entries p ON p.id = c.to_id WHERE p.id IS NULL;
	RAISE NOTICE 'memory_relations.to_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM project_members c LEFT JOIN projects p ON p.id = c.project_id WHERE p.id IS NULL;
	RAISE NOTICE 'project_members.project_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM project_members c LEFT JOIN "user" p ON p.id = c.user_id WHERE p.id IS NULL;
	RAISE NOTICE 'project_members.user_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM projects c LEFT JOIN "user" p ON p.id = c.owner_user_id WHERE p.id IS NULL;
	RAISE NOTICE 'projects.owner_user_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM user_tokens c LEFT JOIN "user" p ON p.id = c.user_id WHERE p.id IS NULL;
	RAISE NOTICE 'user_tokens.user_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM user_active_project c LEFT JOIN "user" p ON p.id = c.user_id WHERE p.id IS NULL;
	RAISE NOTICE 'user_active_project.user_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM user_active_project c LEFT JOIN projects p ON p.id = c.project_id WHERE p.id IS NULL;
	RAISE NOTICE 'user_active_project.project_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM memory_entries c LEFT JOIN projects p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL;
	RAISE NOTICE 'memory_entries.project_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM memory_changes c LEFT JOIN memory_entries p ON p.id = c.entry_id WHERE p.id IS NULL;
	RAISE NOTICE 'memory_changes.entry_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM metrics_samples c LEFT JOIN "user" p ON p.id = c.user_id WHERE p.id IS NULL;
	RAISE NOTICE 'metrics_samples.user_id orphan rows before FK: %', orphan_count;
	SELECT count(*) INTO orphan_count FROM user_quotas c LEFT JOIN "user" p ON p.id = c.user_id WHERE p.id IS NULL;
	RAISE NOTICE 'user_quotas.user_id orphan rows before FK: %', orphan_count;
END $$;--> statement-breakpoint
ALTER TABLE memory_access ADD CONSTRAINT memory_access_entry_fk FOREIGN KEY (entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE memory_fts ADD CONSTRAINT memory_fts_entry_fk FOREIGN KEY (entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_from_fk FOREIGN KEY (from_id) REFERENCES memory_entries(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_to_fk FOREIGN KEY (to_id) REFERENCES memory_entries(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE project_members ADD CONSTRAINT project_members_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE project_members ADD CONSTRAINT project_members_user_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE projects ADD CONSTRAINT projects_owner_user_fk FOREIGN KEY (owner_user_id) REFERENCES "user"(id) ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE user_tokens ADD CONSTRAINT user_tokens_user_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE user_active_project ADD CONSTRAINT user_active_project_user_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE user_active_project ADD CONSTRAINT user_active_project_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE memory_entries ADD CONSTRAINT memory_entries_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE memory_changes ADD CONSTRAINT memory_changes_entry_fk FOREIGN KEY (entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE metrics_samples ADD CONSTRAINT metrics_samples_user_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE user_quotas ADD CONSTRAINT user_quotas_user_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE NOT VALID;
