// Quota reads. Transcribed from warm-store/index.ts getUserQuota /
// countEntriesForUser.
package warmstore

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// GetUserQuota — per-user overrides; nil fields = server defaults,
// absent row = both defaults.
func (s *Store) GetUserQuota(ctx context.Context, userID string) (maxEntries, writesPerMinute *int, err error) {
	err = s.Pool.QueryRow(ctx,
		`SELECT max_entries, writes_per_minute FROM user_quotas WHERE user_id = $1 LIMIT 1`,
		userID).Scan(&maxEntries, &writesPerMinute)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	return maxEntries, writesPerMinute, err
}

// CountEntriesForUser — entry count across every scope the user owns
// (the capacity side of quota enforcement).
func (s *Store) CountEntriesForUser(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM memory_entries WHERE user_id = $1`, userID).Scan(&n)
	return n, err
}
