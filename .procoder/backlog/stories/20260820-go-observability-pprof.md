# Go server observability: pprof and goroutine metrics

Status: open
Created: 2026-08-20
Epic: post-migration-gaps
Sprint: 001-close-the-decision-free-debt-dead-ts-server-scaffolding

## Description

Parity-audit item #16, deferred "until Go becomes primary" — it is
primary now. The soak audit could not measure goroutine counts because
the server exposes no net/http/pprof handler and no go_goroutines
metric; an operator debugging a leak today has nothing to look at.

## Acceptance criteria

- [ ] go_goroutines (and standard Go runtime metrics) exposed on the Prometheus endpoint
- [ ] pprof reachable on an operator-gated surface (admin-authenticated or localhost-only — decide and document)
- [ ] soak re-run confirms goroutine count is flat under load

## Evidence

