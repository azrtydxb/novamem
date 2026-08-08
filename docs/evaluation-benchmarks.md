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

To emit a LongMemEval/Mem0-compatible aggregate report, use:

```bash
node packages/benchmarks/dist/cli.js \
  --fixture packages/benchmarks/fixtures/novamem-recall-smoke.json \
  --format comparable \
  --project-name novamem-smoke \
  --top-k-cutoffs 10,20,50,200
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
  --cleanup \
  --format comparable \
  --project-name novamem-live \
  --answerer-model novamem-search-answer \
  --judge-model exact-match-token-f1 \
  --top-k-cutoffs 10,20,50,200
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

There are two metric layers:

1. **Comparable headline report** (`--format comparable`) — use this when comparing NovaMem with Mem0 memory-benchmarks, LongMemEval result dumps, or similar public scorecards. It emits:
   - `metadata.benchmark`, `project_name`, `answerer_model`, `judge_model`, `provider`, `top_k`, and `top_k_cutoffs`.
   - `metrics_by_cutoff.top_10/top_20/top_50/top_200.overall.accuracy` as a percentage.
   - `metrics_by_cutoff.*.by_question_type` for LongMemEval categories such as `knowledge-update`, `multi-session`, `single-session-user`, `single-session-assistant`, `single-session-preference`, and `temporal-reasoning`.
   - `evaluations[]` with per-question answer, score, correctness, retrieval ranks, relevant hits, and forbidden/stale hits.

2. **Internal diagnostics** — retained under `diagnostics` in comparable reports and as the default report format:
   - `retrieval.byK[*].recall` — fraction of relevant memories retrieved within K.
   - `retrieval.byK[*].precision` — fraction of top-K results that are relevant.
   - `retrieval.byK[*].mrr` — mean reciprocal rank of first relevant hit.
   - `retrieval.byK[*].ndcg` — ranking quality with binary relevance.
   - `answer.exactMatch` — normalized exact match against expected answers.
   - `answer.tokenF1` — token overlap F1.
   - `safety.forbiddenHitRateAtK` — how often superseded/forbidden memories appear in top-K.
   - `latency` — average, p95, and max retrieval latency.

### Scores are not comparable across embedding models

Two measurements from a 50-question LongMemEval slice on `nova-bench`
(bge-m3, 1024-dim) that are easy to get wrong:

**`DEFAULT_WEIGHTS` are calibrated for a weak embedder.** With bge-m3,
searching with `{ keyword: 0, vector: 1, graph: 0, recency: 0, entity: 0 }`
beat the shipped defaults on every retrieval metric — hit@5 92% → 100%,
Recall@10 50.3% → 56.9%, MRR 0.9 → 1.0 — and reproduced on a disjoint
60-question set (hit@10 95.0% → 98.3%, Recall@20 70.1% → 75.4%). `ts_rank`
is max-normalised per query, so the best lexical match in a result set
always scores 1.0 and takes its full 0.25 weight even when it is a poor
match, which is enough to outrank a strong semantic hit. The defaults are
unchanged — they still suit stores of short factual memories where exact
identifiers matter — but a deployment using a strong embedder on prose
should measure before trusting them.

**Recency contributes nothing on imported corpora.** A `recency: 0` arm
scored byte-identical to the default. Every entry ingested in one batch
has the same `updated_at`, so the signal is a constant that consumes 10%
of the weight mass and carries no information.

**There is no model-independent "this was a miss" score.** Measured
question-to-chunk cosines under bge-m3: relevant chunks 0.455–0.651,
irrelevant chunks 0.448–0.564. The bands overlap almost entirely, and the
top-1 result cleared 0.4 on 50 of 50 queries — so a fixed cutoff cannot
detect a miss on this model. Decide from content, and calibrate any floor
against the deployed model.

Do not compare tiny-fixture `Recall@5` smoke-test numbers with public LongMemEval/Mem0 leaderboards. Public comparisons require running the same dataset and reporting the comparable `accuracy` percentages at the same top-k cutoffs, with the answerer and judge models recorded.

## LongMemEval live comparison guardrails

For NovaMem-vs-public LongMemEval comparisons:

- Use the local OpenAI-compatible vLLM endpoint explicitly: `http://192.168.10.246:8888/v1` with model `qwen3.6-35b`.
- Record that answerer and judge are `qwen3.6-35b`; do not label those scores as GPT-5/Gemini judged.
- Current NovaMem `/v1/search` accepts `k <= 200`, matching LongMemEval/Mem0 `top_200` reporting.
- Use chunked `/v1/remember` user/assistant-pair ingestion for direct LongMemEval benchmark storage. This is NovaMem's closest equivalent to Mem0 `add()` for this benchmark shape.
- Do **not** use `/v1/capture` for public-comparable LongMemEval runs. Capture performs semantic read-before-write dedupe/supersession logic on every chunk, which Mem0's benchmark runner does not do at the harness layer.

### Mem0-style concurrent LongMemEval runner

The external Python runner at `packages/benchmarks/scripts/novamem_longmemeval_comparable_runner.py` mirrors the Mem0 `memory-benchmarks` execution shape more closely than the first serial pilot:

- `--max-workers N` runs questions concurrently. Start at `--max-workers 5`; Mem0 defaults to 10, but NovaMem/vLLM capacity should be increased only after a successful pilot.
- Each question uses an isolated namespace in a disposable benchmark project, avoiding leakage between questions while keeping cleanup simple.
- Per-question checkpoints are written under `<out-dir>/questions/<question_id>.json`, so interrupted runs can resume and partial work survives crashes.
- `--predict-only` performs ingest + `/v1/search` only and stores retrieved `top_k` memories in the checkpoint.
- `--evaluate-only` performs answerer/judge evaluation from those checkpoints only; it does not call NovaMem.
- `--rejudge` forces answerer/judge regeneration when checkpointed cutoff results already exist.

Example split run:

```bash
DATA=/home/piwi/.cache/huggingface/hub/datasets--xiaowu0162--longmemeval-cleaned/snapshots/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json
OUT=/tmp/novamem_lme_full_$(date +%Y%m%d%H%M%S)

python3 -u packages/benchmarks/scripts/novamem_longmemeval_comparable_runner.py \
  --dataset "$DATA" \
  --out-dir "$OUT" \
  --limit 500 \
  --cutoffs 10,20,50,200 \
  --max-workers 5 \
  --predict-only

python3 -u packages/benchmarks/scripts/novamem_longmemeval_comparable_runner.py \
  --dataset "$DATA" \
  --out-dir "$OUT" \
  --limit 500 \
  --cutoffs 10,20,50,200 \
  --max-workers 5 \
  --evaluate-only
```

If a run crashes before cleanup, read `<out-dir>/state.json` and delete the recorded disposable project via `DELETE /v1/me/projects/<project>`.

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
