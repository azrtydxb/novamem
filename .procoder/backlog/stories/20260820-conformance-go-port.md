# Port the conformance suite to Go (executes ADR 0003)

Status: done 2026-08-20
Created: 2026-08-20
Epic: conformance-oracle-language
Sprint: 003-the-conformance-oracle-speaks-go

## Description

Port packages/conformance to a standalone Go module that drives a
novamem URL black-box, per ADR 0003: no import of go/internal, no shared
helpers, HTTP only. Case-count parity is pinned before the TS suite is
deleted, and every case's assertions are validated against the TS
original — a port that silently asserts less than the TS case it
replaces is a regression in the oracle, not progress.

## Acceptance criteria

- [x] Go suite runs the same cases (declared and mode-skip behaviour matching the TS suite)
- [x] a module-boundary check fails the build if the suite imports go/internal
- [x] per-case assertion review recorded (spot-checkable mapping TS case → Go case)
- [x] one full run green against a live server; CI wired to the Go suite
- [x] packages/conformance deleted afterwards

## Evidence

- CASE PARITY, measured by running BOTH suites against the same live rig (local Go server, user mode, dashboard on, pgvector cold tier, deterministic stub embedder): identical per-suite counts in all 14 files — 98 passed / 98 passed. Per-suite table (TS pass/skip vs Go pass/skip): meta 5/0 vs 5/0, data-plane 6/0 vs 6/0, search 6/0 vs 6/0, ingest 10/0 vs 10/0, auth 9/0 vs 9/0, better-auth 31/0 vs 31/0, dashboard 4/0 vs 4/0, cors-ratelimit 8/0 vs 8/0, me 3/0 vs 3/0, admin 4/0 vs 4/0, mcp-streamable 6/0 vs 6/0, mcp-sse 1/0 vs 1/0, errors 5/1 vs 5/1, llm 0/5 vs 0/3.
- The ONE delta is llm skip granularity, not coverage: TS emits 4 gated cases + 1 `loud()` placeholder = 5 skip entries; Go skips 3 test functions covering the same 4 cases, each carrying the gate reason (including the placeholder's message). Same surface, fewer report lines.
- Independence: conformance/boundary_test.go parses every file and fails on any non-stdlib import (no go/internal, no clients/go, no third-party assertion lib) — TestOracleImportsOnlyTheStandardLibrary passes.
- Per-case mapping: each of the 13 ported suites was ported by a dedicated agent that returned a TS-case → Go-test/subtest mapping plus its judgment calls; case-name strings are preserved verbatim as t.Run names, so the mapping is spot-checkable by diffing names. Load-bearing TS comments (oracle observations, corrections, rationale) carried over.
- Green live run after deletion: `go test ./...` with the rig env → ok (37.7s). CI posture verified: with NOVAMEM_URL unset the suite compiles, vets and skips → ok (0.6s).
- Wiring: CI go job builds/vets/tests the conformance module; `pnpm conformance` and scripts/conformance-local.sh repointed; CONTRIBUTING updated; conformance/README.md carries the retired package's institutional rules (oracle rule, coverage gate, backend neutrality, loud skips, env contract).
- packages/conformance deleted (tracked files removed; pnpm workspace still builds).
