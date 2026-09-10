package warmstore

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Opt-in, like the migration test:
//
//	NOVAMEM_TEST_DATABASE_URL=postgres://…/throwaway go test ./internal/warmstore
func rateLimitStores(t *testing.T) (*Store, *Store) {
	t.Helper()
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a throwaway database to run")
	}
	ctx := context.Background()
	// Two pools, not one shared pool: two Stores over one database are
	// two replicas, which is the whole property under test.
	poolA, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(poolA.Close)
	poolB, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(poolB.Close)
	if err := Migrate(ctx, poolA, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return New(poolA), New(poolB)
}

func uniqueKey(t *testing.T) string {
	t.Helper()
	return "test-" + t.Name() + "-" + time.Now().Format("150405.000000000")
}

// The regression this change exists for: one budget, however many
// replicas. With per-process counters each replica would count from 1.
func TestTakeRateLimitIsSharedAcrossReplicas(t *testing.T) {
	a, b := rateLimitStores(t)
	ctx := context.Background()
	key := uniqueKey(t)

	for i := 1; i <= 10; i++ {
		replica := a
		if i%2 == 0 {
			replica = b // alternate, as a load balancer would
		}
		count, reset, err := replica.TakeRateLimit(ctx, key, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if count != i {
			t.Fatalf("call %d returned count %d — the counter is not shared", i, count)
		}
		if reset <= 0 || reset > time.Minute {
			t.Fatalf("call %d: reset %v outside the window", i, reset)
		}
	}
}

// Concurrent callers must not lose increments; the whole take is one
// statement precisely so a read and a write cannot interleave.
func TestTakeRateLimitLosesNoIncrementsUnderConcurrency(t *testing.T) {
	a, b := rateLimitStores(t)
	ctx := context.Background()
	key := uniqueKey(t)

	const n = 60
	var wg sync.WaitGroup
	seen := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			replica := a
			if i%2 == 0 {
				replica = b
			}
			count, _, err := replica.TakeRateLimit(ctx, key, time.Minute)
			if err != nil {
				t.Error(err)
				return
			}
			seen[i] = count
		}(i)
	}
	wg.Wait()

	// Every count from 1..n must appear exactly once.
	got := map[int]int{}
	for _, c := range seen {
		got[c]++
	}
	for i := 1; i <= n; i++ {
		if got[i] != 1 {
			t.Fatalf("count %d appeared %d times — increments were lost or duplicated", i, got[i])
		}
	}
}

// The window is fixed: it starts at the first request and requests that
// exceed it do not push it out.
func TestTakeRateLimitWindowIsFixedThenResets(t *testing.T) {
	a, b := rateLimitStores(t)
	ctx := context.Background()
	key := uniqueKey(t)
	const window = 1500 * time.Millisecond

	if _, _, err := a.TakeRateLimit(ctx, key, window); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	_, reset2, err := b.TakeRateLimit(ctx, key, window)
	if err != nil {
		t.Fatal(err)
	}
	if reset2 >= window-300*time.Millisecond {
		t.Fatalf("reset %v did not shrink — the window was extended by the second call", reset2)
	}

	time.Sleep(window)
	count, reset3, err := b.TakeRateLimit(ctx, key, window)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d after the window closed, want a fresh 1", count)
	}
	if reset3 <= window-300*time.Millisecond {
		t.Fatalf("reset = %v, want a full fresh window", reset3)
	}
}

func TestSweepRateLimitsRemovesOnlyClosedWindows(t *testing.T) {
	a, _ := rateLimitStores(t)
	ctx := context.Background()
	live := uniqueKey(t) + "-live"
	closed := uniqueKey(t) + "-closed"

	if _, _, err := a.TakeRateLimit(ctx, live, time.Minute); err != nil {
		t.Fatal(err)
	}
	// A window that has genuinely elapsed, rather than a negative sweep
	// threshold — that would push the cutoff into the future and delete
	// live rows, which is the opposite of what this asserts.
	if _, _, err := a.TakeRateLimit(ctx, closed, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)

	if err := a.SweepRateLimits(ctx, 0); err != nil {
		t.Fatal(err)
	}

	// Count rows directly: a fresh count from TakeRateLimit would prove
	// nothing, since an elapsed window restarts at 1 whether or not the
	// row was ever collected.
	rows := func(key string) int {
		t.Helper()
		var n int
		if err := a.Pool.QueryRow(ctx,
			`SELECT count(*) FROM rate_limits WHERE key = $1`, key).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := rows(closed); n != 0 {
		t.Errorf("closed window: %d row(s) survived the sweep, want 0", n)
	}
	if n := rows(live); n != 1 {
		t.Errorf("live window: %d row(s), want 1 — the sweep collected a window still in use", n)
	}
	// And the live window really is still counting.
	count, _, err := a.TakeRateLimit(ctx, live, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Errorf("live window count = %d, want 2", count)
	}
}
