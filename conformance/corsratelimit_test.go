package conformance

// Port of suites/43-cors-ratelimit.test.ts.
//
// Cross-origin and rate-limit middleware. Transcription source:
// `packages/server/src/http.ts` — the `@fastify/cors` registration
// (allow-list from `NOVAMEM_CORS_ORIGINS`, `credentials` on for an
// explicit list) and the `@fastify/rate-limit` registration with its
// `/health|/live|/ready` allowList. Read-only.
//
// The parity audit (§9.2) listed both as untested surfaces the Go server
// lacked entirely under a green conformance run.
//
// The allowed origin defaults to `http://localhost:5173` — `config.ts`'s
// own default for `corsOrigins`, i.e. what a target that never sets
// NOVAMEM_CORS_ORIGINS actually serves. Override with
// NOVAMEM_CORS_ALLOWED_ORIGIN.

import (
	"strconv"
	"strings"
	"testing"
)

const rejectedOrigin = "http://conformance-rejected-origin.invalid"

// vary joins every Vary header value the way a fetch Headers.get would
// (Go's Header.Get returns only the first line).
func vary(r Result) string {
	return strings.Join(r.Headers.Values("Vary"), ", ")
}

func TestCORS(t *testing.T) {
	e := Target(t)
	allowed := e.CorsAllowedOrigin

	t.Run("preflight from an allowed origin reflects the origin and allows credentials", func(t *testing.T) {
		r := API(t, "/v1/search", Opts{
			Method: "OPTIONS",
			Token:  NoAuth,
			Headers: map[string]string{
				"Origin":                         allowed,
				"Access-Control-Request-Method":  "POST",
				"Access-Control-Request-Headers": "authorization,content-type",
			},
		})
		if r.Status != 204 {
			t.Fatalf("status = %d, want 204", r.Status)
		}
		if got := r.Headers.Get("Access-Control-Allow-Origin"); got != allowed {
			t.Fatalf("access-control-allow-origin = %q, want %q", got, allowed)
		}
		if got := r.Headers.Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Fatalf("access-control-allow-credentials = %q, want %q", got, "true")
		}
		// The reflected method list is the route table's, not the request's.
		methods := r.Headers.Get("Access-Control-Allow-Methods")
		if methods == "" {
			t.Fatal("access-control-allow-methods missing")
		}
		if !strings.Contains(methods, "POST") {
			t.Fatalf("access-control-allow-methods = %q, want it to contain POST", methods)
		}
		// Requested headers are echoed verbatim.
		if got := r.Headers.Get("Access-Control-Allow-Headers"); got != "authorization,content-type" {
			t.Fatalf("access-control-allow-headers = %q, want %q", got, "authorization,content-type")
		}
		// Caching a per-origin decision without Vary would poison shared caches.
		if !strings.Contains(vary(r), "Origin") {
			t.Fatalf("vary = %q, want it to contain Origin", vary(r))
		}
	})

	t.Run("preflight from a rejected origin answers 204 but grants no origin", func(t *testing.T) {
		r := API(t, "/v1/search", Opts{
			Method: "OPTIONS",
			Token:  NoAuth,
			Headers: map[string]string{
				"Origin":                         rejectedOrigin,
				"Access-Control-Request-Method":  "POST",
				"Access-Control-Request-Headers": "authorization,content-type",
			},
		})
		// @fastify/cors still short-circuits the preflight — the denial is
		// the ABSENCE of access-control-allow-origin, which is what makes the
		// browser refuse the real request. A 4xx here would be wrong.
		if r.Status != 204 {
			t.Fatalf("status = %d, want 204", r.Status)
		}
		if got := r.Headers.Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("access-control-allow-origin = %q, want absent", got)
		}
		if !strings.Contains(vary(r), "Origin") {
			t.Fatalf("vary = %q, want it to contain Origin", vary(r))
		}
	})

	t.Run("a non-preflight OPTIONS (no Origin, no Access-Control-Request-Method) is 400", func(t *testing.T) {
		// Not a CORS preflight, so @fastify/cors passes it through to the
		// router, which has no OPTIONS handler for the path.
		r := API(t, "/v1/search", Opts{Method: "OPTIONS", Token: NoAuth})
		if r.Status != 400 {
			t.Fatalf("status = %d, want 400", r.Status)
		}
	})

	t.Run("a simple request from an allowed origin carries the CORS response headers", func(t *testing.T) {
		r := API(t, "/health", Opts{Token: NoAuth, Headers: map[string]string{"Origin": allowed}})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		if got := r.Headers.Get("Access-Control-Allow-Origin"); got != allowed {
			t.Fatalf("access-control-allow-origin = %q, want %q", got, allowed)
		}
		if got := r.Headers.Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Fatalf("access-control-allow-credentials = %q, want %q", got, "true")
		}
	})

	t.Run("a simple request from a rejected origin succeeds but grants no origin", func(t *testing.T) {
		// Server-side the call is just a request; CORS only governs what the
		// BROWSER is then allowed to read. No allow-origin ⇒ unreadable.
		r := API(t, "/health", Opts{Token: NoAuth, Headers: map[string]string{"Origin": rejectedOrigin}})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		if got := r.Headers.Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("access-control-allow-origin = %q, want absent", got)
		}
	})
}

func TestRateLimiting(t *testing.T) {
	Target(t)
	// ponytail: headers + exemption only, deliberately. Actually exhausting
	// the bucket is per-IP and per-process, so a test that drove a limited
	// route to 429 would leave every LATER suite in this run throttled
	// against the same target — the assertion would poison the run it lives
	// in. The per-account auth-failure limiter (5 strikes / 15 min) has the
	// same problem and is likewise not exhausted anywhere in this suite.

	t.Run("a limited route advertises the x-ratelimit-* triple", func(t *testing.T) {
		// /v1/adoption rather than /v1/stats: same limiter, but stats runs a
		// per-namespace aggregation that can take tens of seconds on a loaded
		// shared oracle (see 10-data-plane's timeout note) — this test is
		// about headers, not about waiting for a report.
		r := API(t, "/v1/adoption", Opts{Body: map[string]any{}})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		limitRaw := r.Headers.Get("X-Ratelimit-Limit")
		remainingRaw := r.Headers.Get("X-Ratelimit-Remaining")
		resetRaw := r.Headers.Get("X-Ratelimit-Reset")
		if limitRaw == "" {
			t.Fatal("x-ratelimit-limit missing")
		}
		if remainingRaw == "" {
			t.Fatal("x-ratelimit-remaining missing")
		}
		if resetRaw == "" {
			t.Fatal("x-ratelimit-reset missing")
		}
		limit, err := strconv.ParseFloat(limitRaw, 64)
		if err != nil || !(limit > 0) {
			t.Fatalf("x-ratelimit-limit = %q, want a number > 0 (%v)", limitRaw, err)
		}
		remaining, err := strconv.ParseFloat(remainingRaw, 64)
		if err != nil || remaining < 0 {
			t.Fatalf("x-ratelimit-remaining = %q, want a number >= 0 (%v)", remainingRaw, err)
		}
		if !(remaining < limit) {
			t.Fatalf("x-ratelimit-remaining = %v, want < limit %v", remaining, limit)
		}
		// timeWindow is "1 minute" — the reset countdown can never exceed it.
		reset, err := strconv.ParseFloat(resetRaw, 64)
		if err != nil || !(reset > 0) || reset > 60 {
			t.Fatalf("x-ratelimit-reset = %q, want a number in (0, 60] (%v)", resetRaw, err)
		}
	})

	t.Run("consecutive calls decrement the remaining budget", func(t *testing.T) {
		first := API(t, "/v1/adoption", Opts{Body: map[string]any{}})
		second := API(t, "/v1/adoption", Opts{Body: map[string]any{}})
		if first.Status != 200 {
			t.Fatalf("first status = %d, want 200", first.Status)
		}
		if second.Status != 200 {
			t.Fatalf("second status = %d, want 200", second.Status)
		}
		a, errA := strconv.ParseFloat(first.Headers.Get("X-Ratelimit-Remaining"), 64)
		b, errB := strconv.ParseFloat(second.Headers.Get("X-Ratelimit-Remaining"), 64)
		if errA != nil || errB != nil {
			t.Fatalf("x-ratelimit-remaining not numeric: %q, %q",
				first.Headers.Get("X-Ratelimit-Remaining"), second.Headers.Get("X-Ratelimit-Remaining"))
		}
		// Strictly less unless the 1-minute window rolled between the two
		// calls (in which case the budget resets upward) — accept either, but
		// never "unchanged", which would mean the limiter isn't counting.
		if !(b == a-1 || b > a) {
			t.Fatalf("remaining went %v -> %v, want a decrement or a window roll upward", a, b)
		}
	})

	t.Run("health probes are exempt from the limiter", func(t *testing.T) {
		for _, path := range []string{"/health", "/live", "/ready"} {
			r := API(t, path, Opts{Token: NoAuth})
			if r.Status != 200 {
				t.Fatalf("%s status = %d, want 200", path, r.Status)
			}
			if got := r.Headers.Get("X-Ratelimit-Limit"); got != "" {
				t.Fatalf("%s must not be counted: x-ratelimit-limit = %q", path, got)
			}
			if got := r.Headers.Get("X-Ratelimit-Remaining"); got != "" {
				t.Fatalf("%s must not be counted: x-ratelimit-remaining = %q", path, got)
			}
		}
	})
}
