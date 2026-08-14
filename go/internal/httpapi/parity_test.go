package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// newTestServerOpts is newTestServer with the fields the parity
// middleware needs (CORS list, rate limit, dashboard switch).
func newTestServerOpts(t *testing.T, mutate func(*Options)) http.Handler {
	t.Helper()
	pool := deadPool(t)
	log := slog.New(slog.DiscardHandler)
	warm := warmstore.New(pool)
	eng := engine.New(engine.Options{Warm: warm, Log: log, MaxContentChars: 4000})
	opts := Options{Pool: pool, Log: log, Engine: eng, Warm: warm, AuthMode: "none"}
	mutate(&opts)
	return New(opts)
}

// ─── CORS ──────────────────────────────────────────────────────────────
// Expectations captured from a live TS server (@fastify/cors 11.3.0)
// with NOVAMEM_CORS_ORIGINS="http://allowed.example,http://localhost:5173".

func TestCORSHeaders(t *testing.T) {
	h := newTestServerOpts(t, func(o *Options) {
		o.CorsOrigins = []string{"http://allowed.example", "http://localhost:5173"}
	})

	t.Run("preflight allowed origin", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("OPTIONS", "/v1/search", nil)
		req.Header.Set("Origin", "http://allowed.example")
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "content-type,authorization")
		h.ServeHTTP(rec, req)
		want := map[string]string{
			"Access-Control-Allow-Origin":      "http://allowed.example",
			"Access-Control-Allow-Credentials": "true",
			"Access-Control-Allow-Methods":     "GET,HEAD,POST",
			"Access-Control-Allow-Headers":     "content-type,authorization",
			"Vary":                             "Origin, Access-Control-Request-Headers",
		}
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status %d, want 204", rec.Code)
		}
		for k, v := range want {
			if got := rec.Header().Get(k); got != v {
				t.Errorf("%s = %q, want %q", k, got, v)
			}
		}
	})

	t.Run("preflight rejected origin keeps allow-origin unset", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("OPTIONS", "/v1/search", nil)
		req.Header.Set("Origin", "http://evil.example")
		req.Header.Set("Access-Control-Request-Method", "POST")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status %d, want 204", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("allow-origin = %q, want unset", got)
		}
		// TS still emits credentials here; only allow-origin is withheld.
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Errorf("allow-credentials = %q, want true", got)
		}
	})

	t.Run("options without request-method is 400", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("OPTIONS", "/v1/search", nil)
		req.Header.Set("Origin", "http://allowed.example")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest || rec.Body.String() != "Invalid Preflight Request" {
			t.Fatalf("got %d %q", rec.Code, rec.Body.String())
		}
	})

	t.Run("simple request echoes allowed origin only", func(t *testing.T) {
		for origin, want := range map[string]string{
			"http://allowed.example": "http://allowed.example",
			"http://evil.example":    "",
		} {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest("GET", "/live", nil)
			req.Header.Set("Origin", origin)
			h.ServeHTTP(rec, req)
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != want {
				t.Errorf("origin %s: allow-origin = %q, want %q", origin, got, want)
			}
			if got := rec.Header().Get("Vary"); got != "Origin" {
				t.Errorf("origin %s: vary = %q, want Origin", origin, got)
			}
		}
	})

	t.Run("wildcard disables credentials", func(t *testing.T) {
		h := newTestServerOpts(t, func(o *Options) { o.CorsOrigins = []string{"*"} })
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/live", nil)
		req.Header.Set("Origin", "http://anything.example")
		h.ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("allow-origin = %q, want *", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
			t.Errorf("allow-credentials = %q, want unset", got)
		}
	})

	t.Run("disabled means no headers and a 404 preflight", func(t *testing.T) {
		h := newTestServerOpts(t, func(o *Options) { o.CorsOrigins = nil })
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("OPTIONS", "/v1/search", nil)
		req.Header.Set("Origin", "http://allowed.example")
		req.Header.Set("Access-Control-Request-Method", "POST")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status %d, want 404", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("allow-origin = %q, want unset", got)
		}
	})
}

// ─── Rate limiting ─────────────────────────────────────────────────────

func TestRateLimitWindow(t *testing.T) {
	h := newTestServerOpts(t, func(o *Options) { o.RateLimitPerMinute = 3 })

	// /health, /live and /ready ARE allow-listed (see
	// TestRateLimitAllowList) — this case needs a limited path, so it
	// uses a data-plane route.
	call := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/openapi.json", nil))
		return rec
	}
	for i, wantRemaining := range []string{"2", "1", "0"} {
		rec := call()
		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d: 429 before the limit", i+1)
		}
		if got := rec.Header().Get("X-RateLimit-Remaining"); got != wantRemaining {
			t.Errorf("request %d: remaining = %q, want %q", i+1, got, wantRemaining)
		}
		if got := rec.Header().Get("X-RateLimit-Limit"); got != "3" {
			t.Errorf("request %d: limit = %q, want 3", i+1, got)
		}
	}
	rec := call()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("4th request: status %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 without Retry-After")
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	msg, _ := body["error"].(string)
	if !strings.HasPrefix(msg, "Rate limit exceeded, retry in ") {
		t.Errorf("429 body = %v, want the TS message shape", body)
	}
}

func TestRateLimitAllowList(t *testing.T) {
	h := newTestServerOpts(t, func(o *Options) { o.RateLimitPerMinute = 1 })
	for i := 0; i < 5; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/live", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("/live request %d: status %d, want 200", i+1, rec.Code)
		}
		if got := rec.Header().Get("X-RateLimit-Limit"); got != "" {
			t.Errorf("/live carries rate-limit headers (%q); TS emits none", got)
		}
	}
}

func TestHumanSeconds(t *testing.T) {
	// @lukeed/ms format(ms, true) over the window the limiter produces.
	for sec, want := range map[int]string{0: "0 seconds", 1: "1 second", 54: "54 seconds", 60: "1 minute"} {
		if got := humanSeconds(sec); got != want {
			t.Errorf("humanSeconds(%d) = %q, want %q", sec, got, want)
		}
	}
}

// ─── Dashboard ─────────────────────────────────────────────────────────

func TestDashboardServesSPA(t *testing.T) {
	h := newTestServerOpts(t, func(o *Options) { o.AdminDashboard = true })
	for _, path := range []string{"/admin", "/admin/", "/admin/index.html"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d, want 200", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("%s: content-type %q, want text/html", path, ct)
		}
		if got := rec.Header().Get("Content-Security-Policy"); got != dashboardCSP {
			t.Errorf("%s: CSP = %q", path, got)
		}
		if !strings.Contains(rec.Body.String(), "/admin/assets/") {
			t.Errorf("%s: body does not reference the hashed assets", path)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/admin/does-not-exist.js", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing asset: status %d, want 404", rec.Code)
	}
}

func TestDashboardDisabled404s(t *testing.T) {
	h := newTestServerOpts(t, func(o *Options) { o.AdminDashboard = false })
	for _, path := range []string{"/admin", "/admin/", "/admin/index.html"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("%s: content-type %q, want the JSON 404 envelope", path, ct)
		}
	}
}

// ─── Password hashing ──────────────────────────────────────────────────
// (auth.HashPassword/VerifyPassword round-trip lives in internal/auth's
// own test; here we pin the email validator the create-user path uses.)

func TestLooksLikeEmail(t *testing.T) {
	for in, want := range map[string]bool{
		"a@b.co":              true,
		"first.last@sub.x.io": true,
		"notanemail":          false,
		"@b.co":               false,
		"a@b":                 false,
		"a@b.":                false,
		"a b@c.co":            false,
		"a@@b.co":             false,
	} {
		if got := looksLikeEmail(in); got != want {
			t.Errorf("looksLikeEmail(%q) = %v, want %v", in, got, want)
		}
	}
}
