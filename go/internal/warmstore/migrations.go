// Package warmstore is the Postgres warm tier. This server owns the
// schema: migrations/ is the drizzle-kit migration set, embedded and
// applied at startup by Migrate below, recorded in the same
// drizzle.__drizzle_migrations journal the TS server used — so a
// database migrated by either server stays usable by the other for as
// long as both exist.
package warmstore

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql migrations/meta/_journal.json
var migrationFS embed.FS

// statementBreakpoint is drizzle-kit's statement separator.
const statementBreakpoint = "--> statement-breakpoint"

type migration struct {
	Tag string
	// When is the journal's `when` — the value stored in created_at and
	// the ordering key drizzle compares against.
	When int64
	// Hash is sha256 of the WHOLE file, hex — drizzle's `hash` column.
	Hash       string
	Statements []string
}

// loadMigrations reads the embedded set in journal order, hashing each
// file exactly as drizzle-orm's readMigrationFiles does.
func loadMigrations() ([]migration, error) {
	raw, err := migrationFS.ReadFile("migrations/meta/_journal.json")
	if err != nil {
		return nil, err
	}
	var journal struct {
		Entries []struct {
			When int64  `json:"when"`
			Tag  string `json:"tag"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(raw, &journal); err != nil {
		return nil, fmt.Errorf("migration journal: %w", err)
	}
	out := make([]migration, 0, len(journal.Entries))
	for _, e := range journal.Entries {
		sql, err := migrationFS.ReadFile("migrations/" + e.Tag + ".sql")
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(sql)
		out = append(out, migration{
			Tag:        e.Tag,
			When:       e.When,
			Hash:       hex.EncodeToString(sum[:]),
			Statements: strings.Split(string(sql), statementBreakpoint),
		})
	}
	return out, nil
}

// LatestMigration is the `when` of the newest embedded migration — the
// schema version this build ships. 0 if the set can't be read.
func LatestMigration() int64 {
	ms, err := loadMigrations()
	if err != nil || len(ms) == 0 {
		return 0
	}
	return ms[len(ms)-1].When
}

// Migrate brings the database up to this build's schema. It reproduces
// the TS server's WarmStore.initialize() in order: legacy cleanups, the
// Better Auth tables, the drizzle migration set, then the Postgres-only
// FTS extras drizzle's schema DSL can't express.
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	for _, stmt := range legacyCleanups {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("legacy cleanup: %w", err)
		}
	}
	for _, stmt := range betterAuthDDL {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("better auth bootstrap: %w", err)
		}
	}
	if err := applyMigrations(ctx, pool, log); err != nil {
		return err
	}
	return ensureFtsExtras(ctx, pool, log)
}

// applyMigrations is drizzle-orm's PgDialect.migrate: create the journal
// schema/table, read the newest recorded created_at, then apply every
// migration newer than it inside ONE transaction, recording each.
func applyMigrations(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS "drizzle"`); err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
		id SERIAL PRIMARY KEY,
		hash text NOT NULL,
		created_at bigint
	)`); err != nil {
		return err
	}
	var last int64
	// coalesce, not "no rows": a fresh table has none, and drizzle treats
	// that as "apply everything".
	if err := pool.QueryRow(ctx,
		`SELECT coalesce(max(created_at), 0) FROM "drizzle"."__drizzle_migrations"`).Scan(&last); err != nil {
		return fmt.Errorf("reading drizzle migration journal: %w", err)
	}

	// Downgrade guard, inherited from the old CheckMigrationVersion: a
	// database carrying a migration NEWER than anything this build ships
	// was migrated by a newer release, and its schema may have moved
	// under us. Refuse rather than serve it.
	if newest := migrations[len(migrations)-1].When; last > newest {
		return fmt.Errorf(
			"schema's latest applied migration is %d, newer than this build's %d — refusing to start against a schema from a newer release",
			last, newest)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	applied := 0
	for _, m := range migrations {
		if last >= m.When {
			continue
		}
		for _, stmt := range m.Statements {
			if strings.TrimSpace(stmt) == "" {
				continue
			}
			if _, err := tx.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("migration %s: %w", m.Tag, err)
			}
		}
		if _, err := tx.Exec(ctx,
			`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values($1, $2)`,
			m.Hash, m.When); err != nil {
			return fmt.Errorf("recording migration %s: %w", m.Tag, err)
		}
		applied++
		log.Info("applied migration", "tag", m.Tag, "when", m.When)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if applied == 0 {
		log.Info("schema up to date", "latestMigration", last)
	}
	return nil
}

// legacyCleanups drop constraints and tables left over from the
// pre-Better-Auth schema (index.ts runLegacyCleanups). Idempotent.
var legacyCleanups = []string{
	`ALTER TABLE IF EXISTS user_tokens DROP CONSTRAINT IF EXISTS user_tokens_user_id_fkey`,
	`ALTER TABLE IF EXISTS projects DROP CONSTRAINT IF EXISTS projects_owner_user_id_fkey`,
	`ALTER TABLE IF EXISTS project_members DROP CONSTRAINT IF EXISTS project_members_user_id_fkey`,
	`DROP TABLE IF EXISTS sessions`,
	`DROP TABLE IF EXISTS users`,
}

// betterAuthDDL are the tables Better Auth owns. Kept here (rather than
// left to Better Auth's own DDL) so the server boots independently of
// when the auth handler initializes — index.ts bootstrapBetterAuthAndFts.
var betterAuthDDL = []string{
	`CREATE TABLE IF NOT EXISTS "user" (
		id text PRIMARY KEY,
		name text NOT NULL,
		email text NOT NULL UNIQUE,
		"emailVerified" boolean NOT NULL DEFAULT false,
		image text,
		"createdAt" timestamptz NOT NULL DEFAULT now(),
		"updatedAt" timestamptz NOT NULL DEFAULT now(),
		role text,
		banned boolean,
		"banReason" text,
		"banExpires" timestamptz
	)`,
	`CREATE TABLE IF NOT EXISTS "session" (
		id text PRIMARY KEY,
		"expiresAt" timestamptz NOT NULL,
		token text NOT NULL UNIQUE,
		"createdAt" timestamptz NOT NULL DEFAULT now(),
		"updatedAt" timestamptz NOT NULL DEFAULT now(),
		"ipAddress" text,
		"userAgent" text,
		"userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
		"impersonatedBy" text
	)`,
	`CREATE INDEX IF NOT EXISTS idx_ba_session_user ON "session"("userId")`,
	`CREATE TABLE IF NOT EXISTS "account" (
		id text PRIMARY KEY,
		"accountId" text NOT NULL,
		"providerId" text NOT NULL,
		"userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
		"accessToken" text,
		"refreshToken" text,
		"idToken" text,
		"accessTokenExpiresAt" timestamptz,
		"refreshTokenExpiresAt" timestamptz,
		scope text,
		password text,
		"createdAt" timestamptz NOT NULL DEFAULT now(),
		"updatedAt" timestamptz NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_ba_account_user ON "account"("userId")`,
	`CREATE TABLE IF NOT EXISTS "verification" (
		id text PRIMARY KEY,
		identifier text NOT NULL,
		value text NOT NULL,
		"expiresAt" timestamptz NOT NULL,
		"createdAt" timestamptz NOT NULL DEFAULT now(),
		"updatedAt" timestamptz NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_ba_verification_identifier ON "verification"(identifier)`,
	`CREATE TABLE IF NOT EXISTS "jwks" (
		id text PRIMARY KEY,
		"publicKey" text NOT NULL,
		"privateKey" text NOT NULL,
		"createdAt" timestamptz NOT NULL DEFAULT now()
	)`,
}

// ensureFtsExtras adds the Postgres-only bits drizzle's schema DSL can't
// model (index.ts ensureFtsExtras). Runs after the migration set so
// memory_fts exists.
func ensureFtsExtras(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	if _, err := pool.Exec(ctx, `ALTER TABLE memory_fts
		ADD COLUMN IF NOT EXISTS tsv tsvector
		GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`); err != nil {
		return fmt.Errorf("memory_fts tsv column: %w", err)
	}
	if _, err := pool.Exec(ctx,
		`CREATE INDEX IF NOT EXISTS idx_fts_tsv ON memory_fts USING gin(tsv)`); err != nil {
		return fmt.Errorf("memory_fts tsv index: %w", err)
	}
	// Best-effort, exactly as the TS server: a database that accumulated
	// duplicates in the pre-index era can't build this unique index, and
	// that is not a reason to refuse to boot — dedup stays racy until the
	// duplicates are collapsed and the service restarts.
	if _, err := pool.Exec(ctx,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_content_hash_scope
		   ON memory_entries (user_id, COALESCE(project_id, ''), content_hash)
		 WHERE content_hash IS NOT NULL`); err != nil {
		log.Warn("could not create idx_entries_content_hash_scope (pre-existing duplicate content hashes?); exact-duplicate writes remain racy until the duplicates are collapsed and the service restarts",
			"err", err)
	}
	return nil
}
