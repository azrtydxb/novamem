package warmstore

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Runs the real migration set against a real database. Opt-in:
//
//	NOVAMEM_TEST_DATABASE_URL=postgres://…/novamem_go_migrate_test go test ./internal/warmstore
//
// Destructive to that database's schema — point it at a throwaway one.
func TestMigrateAppliesAndIsIdempotent(t *testing.T) {
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("CI") == "1" {
			t.Fatal("NOVAMEM_TEST_DATABASE_URL is required in CI")
		}
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a throwaway database to run")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	log := slog.New(slog.DiscardHandler)

	if err := Migrate(ctx, pool, log); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	var foreignKeys, unvalidated int
	if err := pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE NOT convalidated) FROM pg_constraint WHERE contype = 'f' AND conname IN (
		'memory_access_entry_fk', 'memory_fts_entry_fk', 'memory_relations_from_fk', 'memory_relations_to_fk',
		'project_members_project_fk', 'project_members_user_fk', 'projects_owner_user_fk', 'user_tokens_user_fk',
		'user_active_project_user_fk', 'user_active_project_project_fk', 'memory_entries_project_fk',
		'memory_changes_entry_fk', 'metrics_samples_user_fk', 'user_quotas_user_fk')`).Scan(&foreignKeys, &unvalidated); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 14 || unvalidated != 0 {
		t.Fatalf("foreign keys = %d, unvalidated = %d; want 14 validated constraints", foreignKeys, unvalidated)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_tokens (token_hash, user_id) VALUES ('fk-test-token', 'missing-fk-test-user')`); err == nil {
		t.Fatal("user_tokens accepted a row with a missing user")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO memory_fts (entry_id, content) VALUES ('missing-fk-test-entry', 'orphan')`); err == nil {
		t.Fatal("memory_fts accepted a row with a missing entry")
	}
	rows, latest := journalState(ctx, t, pool)
	want := len(mustLoad(t))
	if rows != want {
		t.Errorf("journal has %d rows after a fresh migrate, want %d", rows, want)
	}
	if latest != LatestMigration() {
		t.Errorf("latest created_at = %d, want %d", latest, LatestMigration())
	}

	// Second run must touch nothing.
	if err := Migrate(ctx, pool, log); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if rows2, latest2 := journalState(ctx, t, pool); rows2 != rows || latest2 != latest {
		t.Errorf("second migrate changed the journal: %d/%d → %d/%d", rows, latest, rows2, latest2)
	}

	// Journal rows must be shaped like drizzle's: 64-char hex hash and the
	// journal's `when` in created_at.
	for _, m := range mustLoad(t) {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM "drizzle"."__drizzle_migrations" WHERE hash = $1 AND created_at = $2`,
			m.Hash, m.When).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("migration %s: %d journal rows with drizzle's (hash, created_at), want 1", m.Tag, n)
		}
	}

	// Exercise the float64 storage path against PostgreSQL, including the
	// Store row scanner used by normal entry reads.
	const precise = 0.1234567890123
	if _, err := pool.Exec(ctx, `INSERT INTO memory_entries (id, content, confidence) VALUES ('precision-test', 'test', $1)
		ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, confidence = EXCLUDED.confidence`, precise); err != nil {
		t.Fatalf("insert precise confidence: %v", err)
	}
	entry, err := scanEntry(pool.QueryRow(ctx, `SELECT `+entryColumns+` FROM memory_entries WHERE id = 'precision-test'`))
	if err != nil {
		t.Fatalf("scan precise confidence: %v", err)
	}
	if entry.Confidence != precise {
		t.Errorf("confidence round-trip = %.16g, want %.16g", entry.Confidence, precise)
	}
	var effectiveDays, strength float64
	if err := pool.QueryRow(ctx, `INSERT INTO decay_runs (effective_days) VALUES ($1) RETURNING effective_days`, precise).Scan(&effectiveDays); err != nil {
		t.Fatalf("effective_days round-trip: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO memory_entries (id, content) VALUES ('precision-a', 'test'), ('precision-b', 'test')
		ON CONFLICT (id) DO NOTHING`); err != nil {
		t.Fatalf("insert relation endpoints: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO memory_relations (from_id, to_id, strength) VALUES ('precision-a', 'precision-b', $1)
		ON CONFLICT (from_id, to_id, relation) DO UPDATE SET strength = EXCLUDED.strength RETURNING strength`, precise).Scan(&strength); err != nil {
		t.Fatalf("strength round-trip: %v", err)
	}
	if effectiveDays != precise || strength != precise {
		t.Errorf("float round-trips effective_days=%.16g strength=%.16g, want %.16g", effectiveDays, strength, precise)
	}
	var coldExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memory_entries' AND column_name = 'cold')`).Scan(&coldExists); err != nil {
		t.Fatal(err)
	}
	if !coldExists {
		t.Error("memory_entries.cold is required by decay, stats, and vector reconciliation paths")
	}
}

func journalState(ctx context.Context, t *testing.T, pool *pgxpool.Pool) (rows int, latest int64) {
	t.Helper()
	if err := pool.QueryRow(ctx,
		`SELECT count(*), coalesce(max(created_at), 0) FROM "drizzle"."__drizzle_migrations"`,
	).Scan(&rows, &latest); err != nil {
		t.Fatal(err)
	}
	return rows, latest
}

func mustLoad(t *testing.T) []migration {
	t.Helper()
	ms, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	return ms
}
