package main

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/warmstore"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Uses the same Postgres URL convention as CI-backed Go tests. Point it only
// at a scratch database: this test applies the production migration set.
func TestRestoreInventoryAndDrift(t *testing.T) {
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("NOVAMEM_TEST_DATABASE_URL is unset in CI")
		}
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a scratch Postgres database")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := warmstore.Migrate(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatalf("migrate restored DB: %v", err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS backup_verify_test (id integer PRIMARY KEY, payload text NOT NULL); TRUNCATE backup_verify_test; INSERT INTO backup_verify_test VALUES (1,'fixture-safe')`); err != nil {
		t.Fatal(err)
	}
	before, err := inventory(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if err := compare(before, before); err != nil {
		t.Fatalf("matching inventories rejected: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE backup_verify_test SET payload='drifted' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	after, err := inventory(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if err := compare(before, after); err == nil {
		t.Fatal("content drift was not detected")
	}
	if _, err := pool.Exec(ctx, `DROP TABLE backup_verify_test`); err != nil {
		t.Fatal(err)
	}
}
