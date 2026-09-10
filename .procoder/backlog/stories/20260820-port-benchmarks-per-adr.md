# Execute the benchmark-harness ADR

Status: open
Created: 2026-08-20
Epic: bench-harness-consolidation
Sprint: -
Carried: 006-the-model-free-half-of-the-go-bench-harness — live/LongMemEval runners and the TS deletion need the models back — ADR 0004 requires reproducing a published number before deleting anything; the model-free half landed

## Description

Whatever 20260820-bench-harness-target-decision decides, do it: port or
fold the recall-eval fixture runner, rewire the root bench:smoke script
and any CI usage, delete packages/benchmarks, and sweep docs that
reference it.

## Acceptance criteria

- [x] fixture-based smoke eval runs green in the surviving harness
- [ ] packages/benchmarks deleted; workspace and CI references gone
- [ ] docs/evaluation-benchmarks.md and docs-site evaluation pages updated

## Evidence

- go/internal/bench + go/cmd/novamem-bench carry the model-free half of the harness: metrics (normalisation, exact match, token F1, recall/precision/MRR/nDCG per cutoff, p95), the fixture runner, and the lexical retriever.
- PARITY MEASURED: testdata/smoke-report.golden.json is the report `pnpm bench:smoke` actually produced from the TS harness, captured before retirement. The Go report is deep-equal to it — metrics, rankings, answers, safety, ordering — with latency excluded, since that measures the machine rather than the result and no two runs agree on it.
- `pnpm bench:smoke` now runs the Go command and prints the same numbers.
- Extra coverage beyond the port: superseded memories are asserted unretrievable (the failure the fixture format exists to model), and percentile indexing is pinned to the TypeScript's ceil(p/100\*n)-1 rule.
- Two findings while porting, both fixed: the fixture's `source` is an object rather than a string (kept as raw JSON), and my first TokenF1 test example used "a" — an article the normaliser strips — so it asserted the wrong number; replaced with non-article tokens plus a case that pins the article-stripping itself.
- NOT done, and not waivable: the live-server and LongMemEval runners, and deleting packages/benchmarks. ADR 0004 requires reproducing a published number in the Go harness BEFORE anything is deleted, and that needs the model endpoints (offline). The fixture also still lives in packages/benchmarks/fixtures — it moves into the Go tree when that package goes.
