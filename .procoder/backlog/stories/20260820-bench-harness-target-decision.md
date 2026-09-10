# Decision: benchmark harness target (Go vs Python)

Status: open
Created: 2026-08-20
Epic: bench-harness-consolidation
Sprint: -
Carried: 006-the-model-free-half-of-the-go-bench-harness — reproducing a published benchmark number needs the model endpoints, which are offline; the smoke-gate criterion landed

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
- [x] the bench:smoke gate (currently `pnpm bench:smoke` → TS fixture runner) has an equivalent in the surviving harness
- [ ] a published benchmark number is reproduced with the surviving harness before the TS package is deleted

## Evidence

- ADR 0004 (one Go harness replaces packages/benchmarks AND bench/ Python; numbers re-validated before deletion) accepted 2026-08-20
- `pnpm bench:smoke` now runs `go run ./cmd/novamem-bench`, and its report is byte-equal to the TypeScript harness's on the same fixture (see 20260820-port-benchmarks-per-adr for the parity evidence).
- Still open: reproducing a published benchmark number before the TS package is deleted. That needs the model endpoints, which are offline — carried rather than waived, because the whole point of the criterion is that deletion is irreversible.
