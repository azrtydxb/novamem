# 0004 — One Go benchmark harness replaces TS and Python

Status: accepted
Date: 2026-08-20

## Context

Two overlapping harnesses: packages/benchmarks (TS — fixture smoke gate,
LongMemEval live runners, the comparable-report generator behind
docs/benchmarks/longmemeval-2026-08.md) and bench/ (Python — retrieval/
parity benchmarking, LoCoMo tooling, answer eval; the parity-audit
numbers). The boundary is already blurred (a Python runner lives inside
the TS package). Every published number must stay reproducible.

## Decision

Build one Go harness covering both: fixture smoke gate, LongMemEval and
LoCoMo dataset runners, retrieval metrics, comparable reports. Rejected:
folding TS into Python (least work, but leaves a permanent Python
toolchain and an ungated harness) and a Go/Python split (institutionalizes
duplicated adapters — today's drift problem, forever).

## Consequences

Easier: whole repo one language; harness under the same type/lint/test
gates as the server; a static binary anyone can run without a Python
env. Harder: the largest port in the milestone (~1.9k LOC TS + ~1.5k LOC
Python); every published benchmark family must be re-validated against
the Go port BEFORE the originals are deleted — metric drift found later
would poison trust in the numbers; ad-hoc eval experimentation loses
Python's convenience, so the harness needs a good plumbing/query CLI to
compensate.
