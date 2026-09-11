// Global request rate limiter — http.ts's @fastify/rate-limit
// registration (max = NOVAMEM_RATE_LIMIT_PER_MINUTE ?? 600,
// timeWindow "1 minute", allowList /health|/live|/ready).
//
// Contract verified against the TS server:
//   - every non-allow-listed answer carries x-ratelimit-limit,
//     x-ratelimit-remaining and x-ratelimit-reset (whole seconds left in
//     the window); allow-listed paths carry none.
//   - over the limit: 429 + retry-after, body
//     {"error":"Rate limit exceeded, retry in 54 seconds"} — the message
//     is @lukeed/ms `format(ttl, true)`, which the TS error handler
//     unwraps into the standard {error} envelope.
//   - the window is fixed: it starts at the first request for a key and
//     is not extended by requests that exceed it.
package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	rateLimitWindow = time.Minute
	// How often the opportunistic sweep runs, in requests.
	rateLimitSweepEvery = 2048
)

// lastDegradeWarn throttles the "fell back to the local counter"
// warning; unix seconds of the last one emitted.
var lastDegradeWarn atomic.Int64

type rateEntry struct {
	count   int
	resetAt time.Time
}

// rateLimiter is a fixed-window counter per key, held in this process.
//
// It is the fallback path only. Per-replica counters grant N replicas N
// times the configured budget, which weakens a protection rather than
// just skewing a header, so the limiter prefers the shared Postgres
// counter (warmstore.TakeRateLimit) and falls back here only when there
// is no warm store to reach.
type rateLimiter struct {
	mu  sync.Mutex
	m   map[string]rateEntry
	max int
}

func newRateLimiter(max int) *rateLimiter {
	return &rateLimiter{m: map[string]rateEntry{}, max: max}
}

// take records one request against key and reports the remaining budget
// and the time left in the window.
func (l *rateLimiter) take(key string) (remaining int, reset time.Duration, exceeded bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	e, ok := l.m[key]
	if !ok || !e.resetAt.After(now) {
		// New window. Sweep expired keys occasionally so a churn of
		// one-shot client IPs can't grow the map without bound.
		if len(l.m) >= 4096 {
			for k, v := range l.m {
				if !v.resetAt.After(now) {
					delete(l.m, k)
				}
			}
		}
		e = rateEntry{count: 0, resetAt: now.Add(rateLimitWindow)}
	}
	e.count++
	l.m[key] = e
	remaining = l.max - e.count
	if remaining < 0 {
		remaining = 0
	}
	return remaining, time.Until(e.resetAt), e.count > l.max
}

// rateLimit wraps the mux. It runs before the auth middleware, unlike
// the TS server where an unauthenticated 401 short-circuits ahead of the
// limiter — a deliberate improvement: unauthenticated traffic is exactly
// what a limiter is for.
func (s *server) rateLimit(next http.Handler) http.Handler {
	if s.limitPerMinute <= 0 {
		return next
	}
	l := newRateLimiter(s.limitPerMinute)
	var sweepTick atomic.Uint64
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health", "/live", "/ready":
			next.ServeHTTP(w, r)
			return
		}
		// clientIP is X-Forwarded-For aware (the TS server keys on the
		// socket address, which behind an ingress puts every caller in
		// one bucket). ponytail: XFF is client-settable, so a determined
		// caller can evade the limit; a trusted-proxy allow-list is the
		// upgrade path.
		key := clientIP(r)
		remaining, reset, exceeded, ok := s.takeShared(r.Context(), key, &sweepTick)
		if !ok {
			// Degrade to the in-process counter rather than to no
			// limiting at all: per-replica budgets are weaker than a
			// shared one but far better than an unlimited window while
			// the database is unreachable. Warn at most once a minute —
			// during an outage this path runs on every request, and the
			// downgrade must not be silent.
			if s.warm != nil {
				now := time.Now().Unix()
				if last := lastDegradeWarn.Load(); now-last >= 60 &&
					lastDegradeWarn.CompareAndSwap(last, now) {
					s.log.Warn("ratelimit: shared counter unavailable, " +
						"falling back to this replica's own counter")
				}
			}
			remaining, reset, exceeded = l.take(key)
		}
		resetSec := int(reset.Seconds())
		if reset > 0 && reset%time.Second != 0 {
			resetSec++ // Math.ceil, as @fastify/rate-limit does
		}
		h := w.Header()
		h.Set("X-RateLimit-Limit", strconv.Itoa(s.limitPerMinute))
		h.Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		h.Set("X-RateLimit-Reset", strconv.Itoa(resetSec))
		if exceeded {
			h.Set("Retry-After", strconv.Itoa(resetSec))
			writeJSONValue(w, http.StatusTooManyRequests, map[string]any{
				"error": "Rate limit exceeded, retry in " + humanSeconds(resetSec),
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// takeShared records the request against the shared Postgres counter.
// ok is false when there is no warm store or the query failed, which is
// what selects the caller's fallback.
func (s *server) takeShared(ctx context.Context, key string, sweepTick *atomic.Uint64) (
	remaining int, reset time.Duration, exceeded bool, ok bool) {

	if s.warm == nil {
		return 0, 0, false, false
	}
	count, reset, err := s.warm.TakeRateLimit(ctx, key, rateLimitWindow)
	if err != nil {
		return 0, 0, false, false
	}
	// Opportunistic cleanup, so closed windows cannot accumulate without
	// a background goroutine to own and shut down.
	if sweepTick.Add(1)%rateLimitSweepEvery == 0 {
		go func() {
			c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if err := s.warm.SweepRateLimits(c, time.Hour); err != nil {
				s.log.Warn("ratelimit: sweep failed", "err", err)
			}
		}()
	}
	remaining = s.limitPerMinute - count
	if remaining < 0 {
		remaining = 0
	}
	return remaining, reset, count > s.limitPerMinute, true
}

// humanSeconds reproduces @lukeed/ms `format(ms, true)` over the range
// the limiter can produce (0…60 s).
func humanSeconds(sec int) string {
	if sec >= 60 {
		return "1 minute"
	}
	if sec == 1 {
		return "1 second"
	}
	return strconv.Itoa(sec) + " seconds"
}
