// Package warmstore is the Postgres warm tier. In the skeleton slice it
// only carries the migration-version startup check: Drizzle (the TS
// server's migrator) remains the single owner of the schema for the
// whole migration, and this server refuses to start against a schema
// version it does not know (frozen-contract rule from the design spec).
package warmstore

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ExpectedMigrations is the number of applied drizzle migrations this
// build understands (0000..000N in packages/server/src/warm-store/
// migrations). Bump it in the same PR as any new migration.
// ponytail: a count, not a hash chain — good enough to catch "schema
// moved without a Go release"; upgrade to journal-hash comparison when
// Go owns queries that a reordered migration could silently break.
const ExpectedMigrations = 9

// CheckMigrationVersion refuses unknown schema versions. Fewer applied
// migrations than expected is equally fatal: the code would query
// columns that don't exist yet.
func CheckMigrationVersion(ctx context.Context, pool *pgxpool.Pool) error {
	var n int
	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM drizzle.__drizzle_migrations`).Scan(&n)
	if err != nil {
		return fmt.Errorf("reading drizzle migration journal: %w", err)
	}
	if n != ExpectedMigrations {
		return fmt.Errorf(
			"schema at drizzle migration %d, this build expects %d — refusing to start against an unknown schema version",
			n, ExpectedMigrations)
	}
	return nil
}
