package engine

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"
)

// newQuotaEngine builds an engine whose DB seams are pure functions —
// the window/counting logic under test never touches Postgres.
func newQuotaEngine(quotas Quotas, count *int) (*Engine, *time.Time) {
	e := New(Options{Log: slog.New(slog.DiscardHandler), Quotas: quotas})
	clock := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return clock }
	e.getUserQuota = func(context.Context, string) (*int, *int, error) { return nil, nil, nil }
	e.countEntries = func(context.Context, string) (int, error) { return *count, nil }
	return e, &clock
}

func quotaErr(t *testing.T, err error, wantMsg string) {
	t.Helper()
	var he *HTTPError
	if !errors.As(err, &he) {
		t.Fatalf("want HTTPError, got %v", err)
	}
	if he.StatusCode != 429 {
		t.Fatalf("status %d, want 429", he.StatusCode)
	}
	if he.Message != wantMsg {
		t.Fatalf("message %q, want %q", he.Message, wantMsg)
	}
}

func TestWriteQuotaWindow(t *testing.T) {
	count := 0
	e, clock := newQuotaEngine(Quotas{WritesPerMinute: 3}, &count)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if err := e.enforceWriteQuota(ctx, "u"); err != nil {
			t.Fatalf("write %d unexpectedly limited: %v", i, err)
		}
	}
	err := e.enforceWriteQuota(ctx, "u")
	quotaErr(t, err, "write quota exceeded: 3 writes/minute — retry after the window resets")

	// 59s in: still the same fixed window.
	*clock = clock.Add(59 * time.Second)
	quotaErr(t, e.enforceWriteQuota(ctx, "u"),
		"write quota exceeded: 3 writes/minute — retry after the window resets")

	// 60s from the window start: fresh window.
	*clock = clock.Add(1 * time.Second)
	if err := e.enforceWriteQuota(ctx, "u"); err != nil {
		t.Fatalf("new window unexpectedly limited: %v", err)
	}
}

func TestEntryQuotaCountCache(t *testing.T) {
	count := 5
	e, clock := newQuotaEngine(Quotas{MaxEntries: 6}, &count)
	ctx := context.Background()

	// count=5 < 6 → allowed; local increment makes it 6.
	if err := e.enforceWriteQuota(ctx, "u"); err != nil {
		t.Fatalf("first write limited: %v", err)
	}
	// Cached count is now at the cap; the real count (still 5) is NOT
	// re-read inside the 30s cache window.
	quotaErr(t, e.enforceWriteQuota(ctx, "u"),
		"entry quota exceeded: 6 stored entries — forget something first")

	// After 30s the count is re-read (still 5) → allowed again.
	*clock = clock.Add(30 * time.Second)
	if err := e.enforceWriteQuota(ctx, "u"); err != nil {
		t.Fatalf("post-recount write limited: %v", err)
	}
}

func TestQuotaDisabledSkipsChecks(t *testing.T) {
	count := 0
	e, _ := newQuotaEngine(Quotas{}, &count)
	e.getUserQuota = func(context.Context, string) (*int, *int, error) {
		t.Fatal("getUserQuota must not be called when both defaults are 0")
		return nil, nil, nil
	}
	if err := e.enforceWriteQuota(context.Background(), "u"); err != nil {
		t.Fatal(err)
	}
}

func TestQuotaPerUserOverrideWins(t *testing.T) {
	count := 0
	e, _ := newQuotaEngine(Quotas{WritesPerMinute: 100}, &count)
	one := 1
	e.getUserQuota = func(context.Context, string) (*int, *int, error) { return nil, &one, nil }
	ctx := context.Background()
	if err := e.enforceWriteQuota(ctx, "u"); err != nil {
		t.Fatalf("first write limited: %v", err)
	}
	quotaErr(t, e.enforceWriteQuota(ctx, "u"),
		"write quota exceeded: 1 writes/minute — retry after the window resets")
}
