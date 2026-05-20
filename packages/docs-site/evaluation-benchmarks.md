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
  --cleanup
```

The live runner creates a temporary project when `--create-project` is set, stores fixture memories with `[bench:<fixture-id>]` markers, searches with `/v1/search`, maps NovaMem ids back to fixture ids, reports metrics, and deletes the temporary project when `--cleanup` is set. Existing-project runs use a unique benchmark namespace by default; if `--cleanup` is set without `--create-project`, the runner deletes only the memories it seeded.

## Metrics

- Recall@K
- Precision@K
- MRR@K
- nDCG@K
- exact match over retrieved-answer hints
- token F1 over retrieved-answer hints
- forbidden-hit rate for stale/superseded memories
- average/p95/max latency

For production, prioritise Recall@5, MRR@5, forbidden-hit rate, and p95 latency. The built-in answer metrics are retrieval-grounding checks, not a full generative RAG judge; add a generator/evaluator layer if you want faithfulness or citation scoring.

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
