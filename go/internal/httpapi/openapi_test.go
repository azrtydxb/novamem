package httpapi

import (
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// The contract must describe exactly the routes this server registers —
// in both directions. A new route without a table entry, or a table
// entry for a route nobody serves, fails here.
func TestOpenAPIMatchesRegisteredRoutes(t *testing.T) {
	pool := deadPool(t)
	log := slog.New(slog.DiscardHandler)
	warm := warmstore.New(pool)
	// user mode is the documented surface: /v1/me/* only registers there.
	_, patterns := newHandler(Options{
		Pool: pool, Log: log, Warm: warm,
		Engine:         engine.New(engine.Options{Warm: warm, Log: log, MaxContentChars: 4000}),
		AuthMode:       "user",
		CookieSecret:   strings.Repeat("x", 32),
		AdminDashboard: true,
	})

	documented := documentedPatterns()
	served := map[string]bool{}
	for _, p := range patterns {
		served[p] = true
	}
	for _, p := range sortedKeys(served) {
		if !documented[p] && !undocumented(p) {
			t.Errorf("route %q is served but not in apiRoutes (add it, or exempt it in undocumented() with a reason)", p)
		}
	}
	for _, p := range sortedKeys(documented) {
		if !served[p] {
			t.Errorf("route %q is documented but not served", p)
		}
	}
}

// The rendered document is what /openapi.json serves and what
// docs/api/openapi.json must contain, byte for byte.
func TestOpenAPIDocumentMatchesCheckedInFile(t *testing.T) {
	want, err := os.ReadFile("../../../docs/api/openapi.json")
	if err != nil {
		t.Skipf("docs/api/openapi.json not reachable: %v", err)
	}
	if got := OpenAPIDocument(); string(got) != string(want) {
		t.Errorf("docs/api/openapi.json is stale — run `go run ./cmd/gen-openapi` (len got=%d want=%d)",
			len(got), len(want))
	}
}

// Guards the meta conformance suite's assertions without needing a live
// server: valid JSON, OpenAPI 3.x, >20 paths.
func TestOpenAPIDocumentShape(t *testing.T) {
	var doc struct {
		OpenAPI string                     `json:"openapi"`
		Paths   map[string]map[string]any  `json:"paths"`
		Info    map[string]json.RawMessage `json:"info"`
	}
	if err := json.Unmarshal(OpenAPIDocument(), &doc); err != nil {
		t.Fatalf("document is not valid JSON: %v", err)
	}
	if !strings.HasPrefix(doc.OpenAPI, "3.") {
		t.Errorf("openapi = %q, want 3.x", doc.OpenAPI)
	}
	if len(doc.Paths) <= 20 {
		t.Errorf("only %d paths documented, conformance requires >20", len(doc.Paths))
	}
}
