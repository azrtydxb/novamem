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
