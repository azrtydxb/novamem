# Go server observability: pprof and goroutine metrics

Status: done 2026-08-20
Created: 2026-08-20
Epic: post-migration-gaps
Sprint: 001-close-the-decision-free-debt-dead-ts-server-scaffolding

## Description

Parity-audit item #16, deferred "until Go becomes primary" — it is
primary now. The soak audit could not measure goroutine counts because
the server exposes no net/http/pprof handler and no go_goroutines
metric; an operator debugging a leak today has nothing to look at.

## Acceptance criteria

- [x] go_goroutines (and standard Go runtime metrics) exposed on the Prometheus endpoint
- [x] pprof reachable on an operator-gated surface (admin-authenticated or localhost-only — decide and document)
- [x] soak re-run confirms goroutine count is flat under load

## Evidence

- RenderProm appends go*goroutines, go_memstats_heap_alloc_bytes, go_memstats_heap_sys_bytes, go_gc_cycles_total after the novamem*\* contract lines (additive — scrape configs unaffected); TestRenderPromSurface pins 72 lines + the new TYPE lines; conformance 60-admin prom case asserts go_goroutines on an enabled dashboard
- Decision documented in config.go + docs/observability.md: NOVAMEM_PPROF_ADDR serves net/http/pprof on a DEDICATED listener (default off) — a separate socket works in every auth mode (a dashboard-gated route is unreachable under auth.mode=bearer) and never rides an exposed port; env-reference.md row added
- 10-min load run 2026-08-20 (local pgvector Postgres, 4 concurrent workers, 58,965 requests, 2,000 entries written): 40 goroutine samples via the pprof listener, band 16–26, half-means 22.2 → 21.9 — flat; server log clean apart from the expected embedder-unreachable warnings (no embeddings endpoint in the rig)
- go build + go test ./... green; conformance typecheck green
