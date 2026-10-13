// Command verify-restore applies NovaMem's embedded migrations to a restored
// backup and compares its row counts and deterministic content samples with
// the live source. It prints metadata and hashes only, never row contents.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/azrtydxb/novamem/go/internal/warmstore"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type tableCheck struct {
	count  int64
	sample string
}

func main() {
	source := flag.String("source", os.Getenv("NOVAMEM_DATABASE_URL"), "source Postgres URL")
	restored := flag.String("restored", os.Getenv("NOVAMEM_RESTORED_DATABASE_URL"), "throwaway restored Postgres URL")
	flag.Parse()
	if *source == "" || *restored == "" {
		fmt.Fprintln(os.Stderr, "source and restored database URLs are required")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := run(ctx, *source, *restored); err != nil {
		fmt.Fprintln(os.Stderr, "backup verification failed:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, sourceURL, restoredURL string) error {
	source, err := pgxpool.New(ctx, sourceURL)
	if err != nil {
		return fmt.Errorf("connect source: %w", err)
	}
	defer source.Close()
	target, err := pgxpool.New(ctx, restoredURL)
	if err != nil {
		return fmt.Errorf("connect restored database: %w", err)
	}
	defer target.Close()
	if err := source.Ping(ctx); err != nil {
		return fmt.Errorf("ping source: %w", err)
	}
	if err := target.Ping(ctx); err != nil {
		return fmt.Errorf("ping restored database: %w", err)
	}
	if err := warmstore.Migrate(ctx, target, slog.New(slog.DiscardHandler)); err != nil {
		return fmt.Errorf("apply server migrations: %w", err)
	}
	var applied int64
	if err := target.QueryRow(ctx, `SELECT coalesce(max(created_at),0) FROM "drizzle"."__drizzle_migrations"`).Scan(&applied); err != nil {
		return fmt.Errorf("read applied schema version: %w", err)
	}
	left, err := inventory(ctx, source)
	if err != nil {
		return fmt.Errorf("inventory source: %w", err)
	}
	right, err := inventory(ctx, target)
	if err != nil {
		return fmt.Errorf("inventory restored database: %w", err)
	}
	if err := compare(left, right); err != nil {
		return err
	}
	fmt.Printf("restore verification passed: applied_schema_version=%d tables=%d sample_rows_per_table=100\n", applied, len(left))
	return nil
}

func compare(left, right map[string]tableCheck) error {
	if len(left) != len(right) {
		return fmt.Errorf("table inventory differs: source=%d restored=%d", len(left), len(right))
	}
	for name, a := range left {
		b, ok := right[name]
		if !ok {
			return fmt.Errorf("table %s missing after restore", name)
		}
		if a.count != b.count {
			return fmt.Errorf("table %s row count differs: source=%d restored=%d", name, a.count, b.count)
		}
		if a.sample != b.sample {
			return fmt.Errorf("table %s sample checksum differs", name)
		}
	}
	return nil
}

func inventory(ctx context.Context, pool *pgxpool.Pool) (map[string]tableCheck, error) {
	rows, err := pool.Query(ctx, `SELECT schemaname, tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
	if err != nil {
		return nil, err
	}
	type named struct{ schema, table string }
	var tables []named
	for rows.Next() {
		var n named
		if err := rows.Scan(&n.schema, &n.table); err != nil {
			rows.Close()
			return nil, err
		}
		tables = append(tables, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make(map[string]tableCheck, len(tables))
	for _, n := range tables {
		id := pgx.Identifier{n.schema, n.table}.Sanitize()
		var count int64
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+id).Scan(&count); err != nil {
			return nil, err
		}
		r, err := pool.Query(ctx, "SELECT to_jsonb(t)::text FROM "+id+" AS t ORDER BY to_jsonb(t)::text LIMIT 100")
		if err != nil {
			return nil, err
		}
		h := sha256.New()
		for r.Next() {
			var value string
			if err := r.Scan(&value); err != nil {
				r.Close()
				return nil, err
			}
			_, _ = h.Write([]byte(value))
			_, _ = h.Write([]byte{'\n'})
		}
		r.Close()
		if err := r.Err(); err != nil {
			return nil, err
		}
		result[n.table] = tableCheck{count: count, sample: hex.EncodeToString(h.Sum(nil))}
	}
	return result, nil
}
