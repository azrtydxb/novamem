// Package warmstore is the Postgres warm tier. Drizzle (the TS server's
// migrator) remains the single owner of the schema for the whole
// migration; this server refuses to start against a schema version it
// does not know (frozen-contract rule from the design spec).
package warmstore

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ExpectedLatestMigration is the `when` timestamp of the LAST entry in
// packages/server/src/warm-store/migrations/meta/_journal.json. Bump it
// in the same PR as any new migration; migrations_journal_test.go reads
// the journal and fails when this drifts.
//
// Latest-timestamp, not row count: the journal table carries residue
// rows from a pre-campaign squash (observed on the bench: ids 1,2 then
// 25..32), so counts differ across environments while the latest
// applied migration is the invariant that actually matters. Nothing
// NEWER than this build knows may be applied either — that means the
// schema moved without a Go release.
const ExpectedLatestMigration int64 = 1786611692270

// CheckMigrationVersion refuses unknown schema versions.
func CheckMigrationVersion(ctx context.Context, pool *pgxpool.Pool) error {
	var latest int64
	err := pool.QueryRow(ctx,
		`SELECT coalesce(max(created_at), 0) FROM drizzle.__drizzle_migrations`).Scan(&latest)
	if err != nil {
		return fmt.Errorf("reading drizzle migration journal: %w", err)
	}
	if latest != ExpectedLatestMigration {
		return fmt.Errorf(
			"schema's latest applied migration is %d, this build expects %d — refusing to start against an unknown schema version",
			latest, ExpectedLatestMigration)
	}
	return nil
}
