package warmstore

import (
	"context"
	"time"
)

// TakeRateLimit records one request against key in a fixed window and
// returns the resulting count and the time left in that window.
//
// The counter lives in Postgres rather than in each process because the
// limiter is a protection: with per-replica counters N replicas grant N
// times the configured budget, and the advertised remaining walks
// backwards between consecutive calls as they land on different pods.
//
// The whole operation is one statement, so concurrent callers — in one
// process or across replicas — cannot interleave a read and a write and
// lose an increment. The window is fixed, matching the previous
// behaviour: it starts at the first request for a key and is not
// extended by requests that exceed it.
//
// The remaining time is computed by the database, not the caller, so a
// clock difference between an app pod and Postgres cannot skew the
// x-ratelimit-reset header.
func (s *Store) TakeRateLimit(ctx context.Context, key string, window time.Duration) (count int, reset time.Duration, err error) {
	ms := window.Milliseconds()
	var secs float64
	err = s.Pool.QueryRow(ctx, `
		INSERT INTO rate_limits (key, count, reset_at)
		VALUES ($1, 1, now() + ($2 * interval '1 millisecond'))
		ON CONFLICT (key) DO UPDATE SET
			count = CASE WHEN rate_limits.reset_at <= now()
				THEN 1 ELSE rate_limits.count + 1 END,
			reset_at = CASE WHEN rate_limits.reset_at <= now()
				THEN now() + ($2 * interval '1 millisecond') ELSE rate_limits.reset_at END
		RETURNING count, GREATEST(0, EXTRACT(EPOCH FROM (reset_at - now())))`,
		key, ms).Scan(&count, &secs)
	if err != nil {
		return 0, 0, err
	}
	return count, time.Duration(secs * float64(time.Second)), nil
}

// SweepRateLimits deletes windows that closed a while ago. Rows are
// keyed by caller, so the table is bounded by distinct callers rather
// than by traffic, but a long tail of one-shot addresses would still
// accumulate without this.
func (s *Store) SweepRateLimits(ctx context.Context, olderThan time.Duration) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM rate_limits WHERE reset_at < now() - ($1 * interval '1 millisecond')`,
		olderThan.Milliseconds())
	return err
}
