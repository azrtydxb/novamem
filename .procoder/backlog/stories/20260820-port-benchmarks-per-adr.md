# Execute the benchmark-harness ADR

Status: open
Created: 2026-08-20
Epic: bench-harness-consolidation
Sprint: -

## Description

Whatever 20260820-bench-harness-target-decision decides, do it: port or
fold the recall-eval fixture runner, rewire the root bench:smoke script
and any CI usage, delete packages/benchmarks, and sweep docs that
reference it.

## Acceptance criteria

- [ ] fixture-based smoke eval runs green in the surviving harness
- [ ] packages/benchmarks deleted; workspace and CI references gone
- [ ] docs/evaluation-benchmarks.md and docs-site evaluation pages updated

## Evidence

