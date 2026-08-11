# bench — measuring whether a change actually helps

Two loops, one discipline: **answer accuracy is the metric** (retrieval
recall/nDCG mis-ranked configurations three separate times in the
Mem0-alignment campaign — they are diagnostics only).

## The fast loop (~15 min) — `quick-gate.sh`

For **read-path** changes: weights, budgets, rerank settings, selection
logic, anything that doesn't change what gets written.

```
./quick-gate.sh my-change --token-file ~/.novamem-bench-token --key-file ~/.fastllm-key
./quick-gate.sh no-rerank --config '{"rerank":false}' ...
```

Re-searches a **standing corpus** (run-id `p6`: all 500 LongMemEval_s
questions, capture write path, living on the nova-bench deployment —
never purge `nb-p6-*`) on a frozen 50-question stratified subset, runs
the LLM answer eval twice, and prints a verdict against
`baselines.json`: aggregate delta plus **question-level flips that
repeated in every replication**. That last part is the point — at n=50
the aggregate moves ±4 pp on judge noise alone, so only systematic flips
count. `verdict.py --promote` records a run as the new baseline.

For **write-path** changes add `--reingest`: same 50 questions, fresh
dated run-id, ~1.5 h including the fact-queue drain.

Wall-clock budget: search ~2 min, each eval replication ~3 min at the
current fastllm throughput, verdict instant.

## The release gate (~overnight) — full 500 questions

Before a stable release: the full corpus, control + candidate arms,
judge model stated in the report. This is the number that goes next to
Mem0's. The fast loop exists so this only runs when the fast loop
already says "improvement".

## Hygiene rules (each encodes a measured failure)

1. One variable per comparison.
2. Warm pods; no deploys or rollouts while a measurement or ingest is in
   flight.
3. Budgeted arms are compared at **equal tokens**, not equal k, and the
   answerer sees exactly what the server returned (`--cutoffs all`).
4. n=50 verdicts need ≥2 replications and the flip analysis; a single
   replication's aggregate is noise.
5. A default changes only with a gate result attached.
6. Ingest concurrency: 8 workers is safe with Qdrant at 24 Gi; the
   6-worker/2,500-collection combination OOM-killed Qdrant on
   2026-08-11 — purge stale corpora before big ingests.

## Files

- `bench_retrieval.py` — ingest / search / purge against a NovaMem server
- `answer_eval.py` — answer + judge over a search report (fastllm-proxy)
- `relevant_counts.py` — per-question relevant-set sizes (chunks+facts)
- `quick-gate.sh` — the fast loop
- `verdict.py` — comparison + baseline registry (`baselines.json`)
- `ref50-qids.json` — the frozen 50-question subset
- `p6-ingest.json` — snapshot of the standing corpus's ingest state
- `longmemeval_s_cleaned.json` — dataset (git-lfs / copied locally, not committed)

Secrets (`bench token`, `fastllm key`) are files you pass by flag or env
(`NOVAMEM_BENCH_TOKEN_FILE`, `FASTLLM_KEY_FILE`) — never committed.
