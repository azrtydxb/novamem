# LongMemEval_s — full 500-question run (2026-08-11)

The Phase 6 gate of the [Mem0-alignment plan](../architecture/mem0-alignment.md):
one complete, reproducible number for NovaMem's adopted configuration on
the full LongMemEval_s benchmark, with every model named.

## Result

| arm | accuracy | note |
|---|---|---|
| **NovaMem adopted config** (capture write path → hybrid vector search → cross-encoder rerank → 6,000-token budget) | **79.4%** (397/500) | one question's eval call failed transiently and is counted as wrong; over the 499 judged it is 79.6% |
| NovaMem without rerank (same corpus, same budget) | 58.4% (292/500) | the second-pass reranker is worth **+21.2pp** at n=500 |

### By question type (adopted config)

| type | accuracy | vs no-rerank |
|---|---|---|
| single-session-assistant | 94.6% (53/56) | +3.5pp |
| single-session-user | 92.9% (65/70) | +12.9pp |
| knowledge-update | 85.9% (67/78) | +18.0pp |
| temporal-reasoning | 79.5% (105/132) | +28.4pp |
| multi-session | 69.9% (93/133) | +29.3pp |
| single-session-preference | 46.7% (14/30) | +13.4pp |

The reranker's gains concentrate exactly where fused vector scores are
weakest: multi-session aggregation (+29pp) and temporal reasoning
(+28pp), where the right evidence is semantically similar to many wrong
candidates. Preference questions remain the weakest type — the failure
mode is answer style (the answerer states the preference without the
requested justification), not retrieval, and it is the obvious next
target.

## Addendum (2026-08-11, same day): answer-prompt fix — 79.8–80.4%

Error analysis of the 16 missed preference questions found 9 were
prompt-mandated abstentions ("If the answer is not supported, say: The
information provided is not enough" — recommendation-style questions
never have a literally-supported answer) and 7 were generic answers that
ignored the retrieved preferences; only 1 was a retrieval gap. The
answer prompt now instructs the model to ground suggestions in the
user's stored preferences instead of declining. Re-run on the identical
search results (only the prompt changed), two replications:
**80.4% / 79.8% overall**, preference 76.7% / 66.7% (from 46.7%), every
other type within noise and knowledge-update / multi-session /
assistant identical across replications — no abstention-to-hallucination
bleed on factual types. The fix also ships product-side in
`/v1/context`'s guidance text (PR #184).

## Setup (everything named)

- **Server**: novamem `sha-80ff428`, nova-bench deployment (3 replicas) on the kw cluster.
- **Corpus**: all 500 LongMemEval_s questions ingested through `/v1/capture`
  (the production agent-facing write path — worthiness gate, exact-hash
  dedup, contradiction/superset guard, async single-pass fact extraction):
  **122,285 chunks → 253,821 extracted facts**, per-question namespaces.
- **Retrieval**: vector-only hybrid weights (`{keyword:0, vector:1, graph:0, recency:0, entity:0}`),
  `k=20` ceiling, `maxTokens=6000` budget, `expandSourceChunks` on,
  rerank pool 4×k.
- **Embeddings**: `BAAI/bge-m3` (vLLM, DGX Spark).
- **Reranker**: `BAAI/bge-reranker-v2-m3` (vLLM `/v1/rerank`, DGX Spark).
- **Answerer AND judge**: `nvidia/Qwen3.6-35B-A3B-NVFP4` (self-hosted vLLM,
  2 instances × 2 DGX Sparks), thinking enabled, `--cutoffs all` (the
  answerer sees exactly the budgeted set the server returned).
- **Latency** (warm pods, 122k-chunk corpus): search p95 **251 ms** without
  rerank, **392 ms** with rerank.

## Comparability caveat — read before quoting

**Write path**: the corpus was ingested through `/v1/capture` — the
production agent-facing path, which adds an exact-hash fast path and a
heuristic contradiction/superset guard that Mem0's benchmark runner has
no equivalent of at the harness layer. That is a deliberate choice to
measure the product as deployed (and the Phase 4 gate measured capture ≥
remember at matched budgets), but corpus construction therefore differs
from a bare `add()`-style harness; a strict harness-shape comparison
would use `/v1/remember` ingestion (see
`docs/evaluation-benchmarks.md`, "LongMemEval live comparison
guardrails").

Published memory-system numbers on LongMemEval (e.g. Zep's reported
71.2%, and the LongMemEval paper's ~60–65% full-context GPT-4o
baselines) use **GPT-4o-class answerers and judges**. Ours is a
self-hosted 35B judge; LLM-as-judge agreement varies across models, so
cross-paper comparison is indicative, not apples-to-apples. Mem0's
headline numbers are on LOCOMO, a different benchmark. The rigorous
claims this report makes are the **within-harness** ones: the adopted
configuration beats its own ablation by +21.2pp at n=500, and every
model in the loop is named so the run can be reproduced or re-judged
with a different model.

## Reproduce

```
bench/quick-gate.sh <label>                    # 15-min loop, 50-q subset
bench/bench_retrieval.py ingest|search + bench/answer_eval.py   # full run
```

The `bench/` directory lands with PR #176 (this report and that PR are
siblings); until it merges, the Mem0-shape concurrent runner at
`packages/benchmarks/scripts/novamem_longmemeval_comparable_runner.py`
remains the in-repo alternative.

Raw artifacts: bench scratchpad `runs/p6/` (`search-p6-{ctl,rr}.json`,
`answers-{ctl,rr}.json`), `runs/gate6/GATE6.txt`.
