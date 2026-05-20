# Memory recall benchmarks

NovaMem includes a benchmark package for measuring memory recall separately from the built-in `memory_evaluate` health checks.

The suite covers:

- LongMemEval-style long-term chat memory.
- LoCoMo-style conversational memory.
- BEIR/RAG retrieval metrics.
- RULER/NIAH-style long-context needle recall.
- NovaMem-specific cases: supersession, forbidden stale memories, project/sensitivity/adoption behaviours.

## Offline smoke

```bash
pnpm bench:smoke
```

This uses `packages/benchmarks/fixtures/novamem-recall-smoke.json` with a deterministic lexical baseline. It is safe for CI and does not contact a NovaMem server.

## Live NovaMem run

```bash
pnpm --filter @azrtydxb/novamem-benchmarks build
NOVAMEM_TOKEN="$(cat ~/.hermes/secrets/novamem_token)" \
node packages/benchmarks/dist/live-cli.js \
  --base-url http://localhost:7778 \
  --fixture packages/benchmarks/fixtures/novamem-recall-smoke.json \
  --create-project \
  --cleanup \
  --format comparable \
  --project-name novamem-live \
  --top-k-cutoffs 10,20,50,200
```

The live runner creates a temporary project when `--create-project` is set, stores fixture memories with `[bench:<fixture-id>]` markers, searches with `/v1/search`, maps NovaMem ids back to fixture ids, reports metrics, and deletes the temporary project when `--cleanup` is set. Existing-project runs use a unique benchmark namespace by default; if `--cleanup` is set without `--create-project`, the runner deletes only the memories it seeded.

## Metrics

Use `--format comparable` for public comparisons with Mem0 memory-benchmarks or LongMemEval result dumps. The comparable report emits `metrics_by_cutoff.top_10/top_20/top_50/top_200.overall.accuracy`, per-question-type accuracy, metadata for answerer/judge/provider, and per-question evaluations.

The default/internal report keeps diagnostics:

- Recall@K
- Precision@K
- MRR@K
- nDCG@K
- exact match over retrieved-answer hints
- token F1 over retrieved-answer hints
- forbidden-hit rate for stale/superseded memories
- average/p95/max latency

Do not compare tiny-fixture Recall@5 smoke numbers with public leaderboards. To know how good NovaMem is, run the same dataset and compare the comparable accuracy percentages at the same top-k cutoffs with answerer and judge models recorded.

## LongMemEval live comparison guardrails

- Local vLLM endpoint: `http://192.168.10.246:8888/v1`, model `qwen3.6-35b`.
- Label answerer/judge as `qwen3.6-35b`; do not present those as GPT-5/Gemini judged scores.
- NovaMem `/v1/search` accepts `k <= 200`, matching LongMemEval/Mem0 `top_200` reporting.
- Use chunked user/assistant-pair ingestion for direct LongMemEval benchmark storage; whole-session `/v1/remember` can fail on large sessions.
- Keep enough retrieved-memory text for answer generation; aggressive truncation caused a false failure on the first LongMemEval question.

## External adapters

Use `packages/benchmarks/src/adapters.ts` to transform upstream datasets:

- `adaptLongMemEvalFixture(...)`
- `adaptLoCoMoFixture(...)`
- `adaptBeirFixture(...)`
- `adaptRagFixture(...)`
- `adaptLongContextFixture(...)`
- `adaptNovaMemFixture(...)`

The repository does not vendor full external datasets; fetch them from upstream and transform locally.

Upstreams:

- LongMemEval: https://github.com/xiaowu0162/LongMemEval
- LoCoMo: https://snap-research.github.io/locomo/
- BEIR: https://github.com/beir-cellar/beir
- RULER: https://github.com/NVIDIA/RULER
