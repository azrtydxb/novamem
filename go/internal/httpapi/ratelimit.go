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
	"net/http"
	"strconv"
	"sync"
	"time"
)

const rateLimitWindow = time.Minute

type rateEntry struct {
	count   int
	resetAt time.Time
}

// rateLimiter is a fixed-window counter per key.
//
// ponytail: in-memory and per-replica, exactly like the existing quota
// limiter and like @fastify/rate-limit's default LocalStore — N replicas
// means an effective ceiling of N × max. A shared store (Redis, or a
// Postgres counter) is the upgrade path if that ever matters.
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
		remaining, reset, exceeded := l.take(clientIP(r))
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
