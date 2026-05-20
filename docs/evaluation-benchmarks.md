# Memory recall benchmarks

NovaMem includes a benchmark package for measuring memory recall separately from the built-in `memory_evaluate` health checks.

The benchmark suite covers five families:

- **LongMemEval-style long-term chat memory** — multi-session facts, updated preferences, temporal/user-specific recall.
- **LoCoMo-style conversational memory** — dialogue/session evidence and narrative consistency.
- **BEIR/RAG retrieval** — corpus/query/qrels evaluation with Recall@K, Precision@K, MRR, and nDCG.
- **Long-context / needle-style recall** — RULER/NIAH-inspired haystack cases represented as external memory chunks.
- **NovaMem-specific behaviours** — supersession avoidance, forbidden stale memories, project/sensitivity/adoption cases.

The package lives in `packages/benchmarks` and provides both offline and live runners.

## Offline smoke benchmark

Run the synthetic fixture with the deterministic lexical baseline:

```bash
pnpm bench:smoke
```

or directly:

```bash
pnpm --filter @azrtydxb/novamem-benchmarks build
node packages/benchmarks/dist/cli.js \
  --fixture packages/benchmarks/fixtures/novamem-recall-smoke.json
```

The offline runner is CI-safe: it does not call a NovaMem server and is intended to validate fixture shape, metrics, and report generation.

## Live NovaMem benchmark

To test the actual deployed memory system, use `novamem-bench-live` after building the package:

```bash
pnpm --filter @azrtydxb/novamem-benchmarks build
NOVAMEM_TOKEN="$(cat ~/.hermes/secrets/novamem_token)" \
node packages/benchmarks/dist/live-cli.js \
  --base-url http://localhost:7778 \
  --fixture packages/benchmarks/fixtures/novamem-recall-smoke.json \
  --create-project \
  --cleanup
```

The live runner:

1. creates a temporary project when `--create-project` is set;
2. stores each fixture memory into that project with a `[bench:<fixture-id>]` marker;
3. runs `/v1/search` for every query;
4. maps generated NovaMem ids back to fixture ids;
5. reports retrieval, answer, stale/forbidden-hit, and latency metrics;
6. deletes the temporary project when `--cleanup` is set.

Use `--project <id-or-name>` instead of `--create-project` when benchmarking an existing project. Do **not** use `--cleanup` unless the project was created just for the benchmark.

## Fixture format

A fixture is a JSON object:

```json
{
  "name": "my-suite",
  "kind": "longmemeval",
  "version": "1",
  "memories": [
    { "id": "m1", "text": "The user prefers Asia/Dubai for schedules." }
  ],
  "queries": [
    {
      "queryId": "q1",
      "text": "Which timezone should schedules use?",
      "expectedAnswer": "Asia/Dubai",
      "relevantMemoryIds": ["m1"],
      "forbiddenMemoryIds": []
    }
  ]
}
```

Supported `kind` values:

- `longmemeval`
- `locomo`
- `beir`
- `rag`
- `long-context`
- `novamem-specific`

## Metrics

The report includes:

- `retrieval.byK[*].recall` — fraction of relevant memories retrieved within K.
- `retrieval.byK[*].precision` — fraction of top-K results that are relevant.
- `retrieval.byK[*].mrr` — mean reciprocal rank of first relevant hit.
- `retrieval.byK[*].ndcg` — ranking quality with binary relevance.
- `answer.exactMatch` — normalized exact match against expected answers.
- `answer.tokenF1` — token overlap F1.
- `safety.forbiddenHitRateAtK` — how often superseded/forbidden memories appear in top-K.
- `latency` — average, p95, and max retrieval latency.

For NovaMem production readiness, the most important numbers are usually:

1. `Recall@5` for whether the right memory is available to the agent;
2. `MRR@5` for whether it appears high enough to be used;
3. `forbiddenHitRateAtK` for stale/superseded-memory leakage;
4. p95 latency for interactive usability.

## External benchmark adapters

`packages/benchmarks/src/adapters.ts` provides adapters for common shapes:

- `adaptLongMemEvalFixture(...)`
- `adaptLoCoMoFixture(...)`
- `adaptBeirFixture(...)`
- `adaptRagFixture(...)`
- `adaptLongContextFixture(...)`
- `adaptNovaMemFixture(...)`

The repository does **not** vendor full external datasets. Fetch them from their upstream sources and transform them with the adapters so licensing and dataset size remain explicit.

Useful upstreams:

- LongMemEval: https://github.com/xiaowu0162/LongMemEval
- LoCoMo: https://snap-research.github.io/locomo/
- BEIR: https://github.com/beir-cellar/beir
- RULER: https://github.com/NVIDIA/RULER
