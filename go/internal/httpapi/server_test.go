package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// A pool aimed at a dead address: /live must still 200 (liveness checks
// nothing) while /ready and /health answer 503 {"ok":false}.
func deadPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig("postgres://u:p@127.0.0.1:1/db?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// newTestServer builds a handler over the dead pool — enough for the
// health probes, auth middleware, and validation-layer tests (none of
// which reach Postgres).
func newTestServer(t *testing.T, authMode, authToken string) http.Handler {
	t.Helper()
	pool := deadPool(t)
	log := slog.New(slog.DiscardHandler)
	warm := warmstore.New(pool)
	eng := engine.New(warm, log, engine.Quotas{}, 4000, nil)
	return New(Options{Pool: pool, Log: log, Engine: eng, Warm: warm, AuthMode: authMode, AuthToken: authToken})
}

func TestHealthContract(t *testing.T) {
	h := newTestServer(t, "none", "")
	for path, want := range map[string]struct {
		status int
		ok     bool
	}{
		"/live":   {200, true},
		"/ready":  {503, false},
		"/health": {503, false},
	} {
		req := httptest.NewRequest("GET", path, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want.status {
			t.Fatalf("%s: status %d, want %d", path, rec.Code, want.status)
		}
		var body struct {
			OK bool `json:"ok"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: body %q not JSON: %v", path, rec.Body.String(), err)
		}
		if body.OK != want.ok {
			t.Fatalf("%s: ok=%v, want %v", path, body.OK, want.ok)
		}
		// Boolean-only contract: no dependency names may leak.
		if rec.Body.Len() > len(`{"ok":false}`) {
			t.Fatalf("%s: body leaks detail: %s", path, rec.Body.String())
		}
		assertHardeningHeaders(t, path, rec)
	}
}

func TestOpenAPIDocServed(t *testing.T) {
	h := newTestServer(t, "none", "")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/openapi.json", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	var doc struct {
		OpenAPI string                    `json:"openapi"`
		Paths   map[string]map[string]any `json:"paths"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.OpenAPI == "" || len(doc.Paths) <= 20 {
		t.Fatalf("doc looks wrong: openapi=%q paths=%d", doc.OpenAPI, len(doc.Paths))
	}
	assertHardeningHeaders(t, "/openapi.json", rec)
}

// The TS server sets these on every response (http.ts global hook); the
// Go server must not drift.
func assertHardeningHeaders(t *testing.T, path string, rec *httptest.ResponseRecorder) {
	t.Helper()
	for header, want := range map[string]string{
		"X-Frame-Options":        "DENY",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Fatalf("%s: header %s = %q, want %q", path, header, got, want)
		}
	}
}
