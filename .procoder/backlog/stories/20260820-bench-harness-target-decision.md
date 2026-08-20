# Decision: benchmark harness target (Go vs Python)

Status: open
Created: 2026-08-20
Epic: bench-harness-consolidation
Sprint: -

## Description

packages/benchmarks (TS) and bench/ (Python) overlap: both drive
retrieval evals against a server URL. The stated goal removes TS
runtimes, but Python was explicitly outside the user's "ts/js → go"
scope — so the honest options are: port packages/benchmarks to Go,
fold its fixtures/adapters into the Python harness, or port both to Go
for a single harness. Published numbers (docs/benchmarks/\*) must remain
reproducible by whatever survives.

## Acceptance criteria

- [x] ADR recorded naming the surviving harness(es) and the fate of packages/benchmarks
- [ ] the bench:smoke gate (currently `pnpm bench:smoke` → TS fixture runner) has an equivalent in the surviving harness
- [ ] a published benchmark number is reproduced with the surviving harness before the TS package is deleted

## Evidence

- ADR 0004 (one Go harness replaces packages/benchmarks AND bench/ Python; numbers re-validated before deletion) accepted 2026-08-20
