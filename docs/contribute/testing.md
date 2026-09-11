---
title: Testing
---

# Testing

The server, the CLIs and the conformance oracle are Go, and tested with
the standard `testing` package — ~190 tests at the time of writing. The
dashboard SPA is the one JavaScript suite, on vitest. CI gates every PR
on green.

## Run

```bash
# The server and everything under it
cd go && go test ./...

# One package
cd go && go test ./internal/engine/

# One test, with output
cd go && go test ./internal/engine/ -run TestHybrid -v

# Re-run without the cache
cd go && go test -count=1 ./internal/engine/
```

The dashboard SPA: `pnpm test`.

## Layout

Tests live beside the source they test, in the same package, so they can
reach unexported functions:

```
go/internal/
├── engine/engine.go
├── engine/hybrid_test.go        — signal fusion and contradiction detection
├── engine/gate_test.go          — the worthiness gate
├── httpapi/server.go
├── httpapi/server_test.go       — routes via httptest.NewRecorder
├── httpapi/parity_test.go       — the HTTP surface against its OpenAPI document
├── mcp/transport.go
└── mcp/transport_test.go        — the MCP handshake, both protocol eras
```

## Fakes vs real datastores

Most tests never reach a database. The pattern is a pool pointed at a
dead address plus `httptest`, which is enough for health probes, the
auth middleware and the validation layer:

```go
func newTestServer(t *testing.T, authMode, authToken string) http.Handler {
	t.Helper()
	pool := deadPool(t) // pgxpool at 127.0.0.1:1, connect_timeout=1
	log := slog.New(slog.DiscardHandler)
	warm := warmstore.New(pool)
	// ...
}
```

Engine tests wire in-memory stores into a `MemoryEngine` and exercise
the whole call path without Postgres or Qdrant.

## Patterns

### Table test

The default shape. One case per row, named, so a failure says which:

```go
func TestSensitivity(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want bool
	}{
		{"credential in prose", "my database password is hunter2", true},
		{"plain prose", "Pascal likes coffee", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsSensitive(tc.in); got != tc.want {
				t.Errorf("IsSensitive(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
```

### Route test

```go
func TestSearchRejectsAnonymous(t *testing.T) {
	h := newTestServer(t, "user", "")
	req := httptest.NewRequest("POST", "/v1/search", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}
```

### Conformance, not unit tests

Anything that depends on a running deployment — every transport, the
auth modes, the dashboard contract — belongs in
[`conformance/`](https://github.com/azrtydxb/novamem/tree/main/conformance),
not in a unit test. It runs against a real target:

```bash
./scripts/conformance-local.sh   # docker compose up/down included
```

The conformance suite is the only oracle for behaviour the server
promises over the wire. A hand probe with `curl` is not a substitute —
it misses whole transports.

## Adding a regression test

When a bug is fixed, add a test that fails on the bad version and passes
on the fix, and say in a comment which break it catches:

```go
// Regression for the cold-tier error path: the engine catches the
// failure and surfaces a degraded result instead of failing the whole
// search.
func TestSearchDegradesWhenColdStoreFails(t *testing.T) {
	// ...
}
```

The comment plus the assertion together document why the test exists.

## CI

`.github/workflows/ci.yml` runs:

1. `cd go && go build ./... && go vet ./... && go test ./...` — the same
   for `clients/go` and `conformance`
2. `golangci-lint run ./...` at the pinned version
3. `cd go && go run ./cmd/gen-contract && go run ./cmd/gen-tool-docs`
   followed by `git diff --exit-code` over `api/`, `docs/api/`,
   `tooldefs.json`, the embedded `openapi.json` and `routes_gen.go` — the
   contract drift gate. `api/openapi.yaml` is the source; every one of
   those is an output of it
4. `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` for the SPA
   and this site
5. `pnpm docs:smoke` — documentation invariants
6. `pnpm audit --prod --audit-level=high`
7. Docker build (amd64 + arm64) + Trivy scan
8. CodeQL static analysis

Branch protection requires all checks green and the branch up to date
with main before merge.
