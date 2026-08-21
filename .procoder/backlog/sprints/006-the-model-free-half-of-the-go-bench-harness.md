# The model-free half of the Go bench harness

Status: closed 2026-08-21
Created: 2026-08-21

## Goal

ADR 0004's Go harness exists for everything that does not need a model:
metrics, the fixture runner, the lexical retriever, and the bench:smoke
gate, reproducing the TypeScript harness's report exactly. The
live-server and LongMemEval runners — and therefore deleting
packages/benchmarks — wait for the model endpoints to come back, because
the ADR requires reproducing a published number before anything is
deleted.

## Result

committed: 2
done: 0
carried: 2 (20260820-bench-harness-target-decision, 20260820-port-benchmarks-per-adr)

## Retro

- What slowed us: nothing external — this sprint was deliberately scoped
  to the half of ADR 0004 that does not touch a model, because the
  models are offline and the ADR forbids deleting the TypeScript harness
  before a published number is reproduced.
- What we change: when a story's criteria straddle an unavailable
  dependency, split the sprint goal at that line up front and say so in
  the goal text, rather than discovering mid-sprint that half the
  criteria cannot be met. Both stories were carried on purpose, not
  because they were misjudged.
- Adaptation worth keeping: capture the oracle from the outgoing
  implementation the moment you decide to replace it. `pnpm bench:smoke`
  output became testdata the same way the installer fixtures and the
  conformance run did — three ports in a row where the parity argument
  was settled by a recorded artifact instead of a code review.
