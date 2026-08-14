package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
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

func TestHealthContract(t *testing.T) {
	h := New(deadPool(t), slog.New(slog.DiscardHandler))
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
	}
}

func TestOpenAPIDocServed(t *testing.T) {
	h := New(deadPool(t), slog.New(slog.DiscardHandler))
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
}
