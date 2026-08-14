package httpapi

import (
	"testing"
	"time"
)

// The sign-in throttle is a security path with a window, a counter and a
// sweep, so it gets a check: three attempts pass, the fourth is refused
// with whole seconds left in the window, and a key whose attempts have
// aged out is not kept in the map.
func TestBARateLimitWindow(t *testing.T) {
	var b baRateLimit
	const window = 10 * time.Second

	for i := 1; i <= 3; i++ {
		if ok, _ := b.allow("ip /sign-in", window, 3); !ok {
			t.Fatalf("attempt %d refused, want allowed", i)
		}
	}
	ok, retry := b.allow("ip /sign-in", window, 3)
	if ok {
		t.Fatal("fourth attempt allowed, want refused")
	}
	if retry < 1 || retry > 10 {
		t.Fatalf("x-retry-after %d, want 1..10", retry)
	}

	// A different caller has its own budget.
	if ok, _ := b.allow("other-ip /sign-in", window, 3); !ok {
		t.Fatal("second caller refused, want its own window")
	}
}

func TestBARateLimitSweepsAgedKeys(t *testing.T) {
	var b baRateLimit
	// A one-nanosecond window: every attempt ages out immediately, so
	// the next call must sweep the key rather than accumulate one per
	// distinct caller forever.
	b.allow("gone", time.Nanosecond, 3)
	time.Sleep(time.Millisecond)
	b.allow("present", time.Nanosecond, 3)
	if _, stale := b.at["gone"]; stale {
		t.Fatalf("aged-out key survived the sweep: %v", b.at)
	}
}

func TestBanExpired(t *testing.T) {
	past := time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	future := time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	if !banExpired(past) {
		t.Fatalf("elapsed ban %q reported as still in force", past)
	}
	if banExpired(future) {
		t.Fatalf("future ban %q reported as expired", future)
	}
	// Unparseable must keep the ban in force rather than silently lift it.
	if banExpired("not a timestamp") {
		t.Fatal("unparseable banExpires lifted the ban")
	}
}
