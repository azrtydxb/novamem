# Retire or verify the audit's remaining unverified items

Status: done 2026-08-20
Created: 2026-08-20
Epic: post-migration-gaps
Sprint: 001-close-the-decision-free-debt-dead-ts-server-scaffolding

## Description

go-parity-audit.md §10 lists items that were unverifiable at audit time.
With packages/server deleted, several are moot (TS-direction cookie
interop, in-cluster TS-vs-Go latency, oracle keyword-tier bug) — but the
document never says so. One paragraph per item in the audit doc, marking
each verified / retired-because-moot, so the ledger reads closed to a
future reader instead of trailing off.

## Acceptance criteria

- [x] every §10 bullet has a written disposition (verified since, retired as moot, or converted to an open story)
- [x] scale-behaviour and Qdrant-cold-store bullets explicitly dispositioned (they are not moot)

## Evidence

- docs/architecture/go-parity-audit.md "Addendum 2 — §10 ledger dispositions (2026-08-20)": all ten §10 bullets dispositioned — 5 verified since (goroutine visibility, LongMemEval 500-run, auth modes, live bench deployment, browser surface superseded), 3 retired as moot with the TS server's deletion (TS-direction cookies, differential latency, oracle bug), 1 converted to story 20260820-bumphits-postfix-soak, scale + Qdrant explicitly held as not-moot with their residual risk named
- LongMemEval claim checked against docs/benchmarks/longmemeval-2026-08.md (79.4%, 500 questions); Qdrant unit coverage checked (go/internal/coldstore/qdrant_test.go exists)

