# Mem0 alignment: target architecture and migration plan

Written 2026-08-09, from a measurement campaign against the `nova-bench`
deployment (LongMemEval slices, bge-m3 embeddings, qwen3-6-35b answerer and
judge with thinking enabled). Every NovaMem number in this document was
measured in that campaign; nothing about NovaMem is projected. Mem0's
figures (their benchmark scores, token budgets, and the 60–70% write-cost
reduction) are their published claims, reproduced here as the reference
point — not independently verified. Where a NovaMem claim rests on n=12,
that is said explicitly — at n=12 one question is 8.3 percentage points, so
single-question differences are noise.

The goal: adopt Mem0's architecture — the highest-scoring published memory
system on the benchmarks we care about — while keeping the NovaMem features
that are genuinely differentiating, **strictly off the hot paths**.

## 1. What Mem0 does

Reconstructed from Mem0's 2026 published material.

**Write (`add()`), one LLM call total:**

1. One "single-pass hierarchical extraction" call: structured facts _and_
   entities extracted together. ADD-only — no conflict check, no
   update/merge decision. Agent-generated facts carry equal weight to user
   statements.
2. Facts batch-embedded and inserted. Entities go into a parallel
   `{collection}_entities` collection. Raw episodic messages persist
   alongside the facts — **facts and raw conversation coexist**.
3. The `relations` field from earlier versions is **gone**: explicit graph
   relations were deliberately removed in favour of implicit ranking
   signals.

Mem0's own framing: the traditional pipeline of _extract → check conflicts
→ update or merge_ costs three sequential LLM calls per memory; collapsing
it to one ADD-only call cut write-time LLM usage 60–70%.

**Read (`search()`):**

1. Three candidate signals in parallel: vector similarity, BM25 keyword,
   and **entity match against the entity collection** — the entity index is
   a candidate _source_, not just a re-ranking signal.
2. Scores normalised and fused.
3. A second-pass reranker (Cohere / HF / sentence-transformers / LLM).
4. Results trimmed to a **token budget** — ~6,800 tokens per query is their
   headline metric across LoCoMo, LongMemEval and BEAM.

**No write-time supersession anywhere.** Memories accumulate; retrieval
ranking and the budget sort it out. Published scores: 93.4–94.4%
LongMemEval (judge model unpublished, so not directly comparable to our
qwen3-judged numbers — our own 2×2 showed the answerer alone swings results
18–24pp).

## 2. Where NovaMem stands (measured)

| Axis                      | Mem0                     | NovaMem today                                                                                                                                                                              | Verdict                                                                             |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Write LLM calls per chunk | **1**                    | ~2 (was ~6 before the 0.85 updation floor)                                                                                                                                                 | Behind, structurally                                                                |
| Write durability          | —                        | **None for facts**: extraction is `void`-scheduled, in-process. A mid-drain pod restart permanently lost 10,446 chunks' facts. Embeddings have had a reconciler (`embedded_at`) all along. | Behind our own embeddings path                                                      |
| Write paths               | one `add()`              | two (`remember`, `capture`) with divergent semantics                                                                                                                                       | Behind — a recurring source of confusion and double cost                            |
| Fusion                    | 3 signals                | 5 signals, same normalise-and-fuse shape                                                                                                                                                   | Convergent — equivalent design reached independently                                |
| Entity retrieval          | candidate source         | ranking signal over already-found candidates only; a true source (`memoriesByEntities`) exists but is welded to the neighbour walk                                                         | Behind by wiring, not capability                                                    |
| Token budget              | default, headline metric | `maxTokens` exists (PR #161), not defaulted                                                                                                                                                | Behind by one config                                                                |
| Reranker                  | second-pass, standard    | none (one measurement, harmful — but in the wrong setting: re-ordering an already-good top-k rather than trimming a pool to budget)                                                        | Open question                                                                       |
| Supersession              | none at write            | LLM ADD/UPDATE/DELETE at write                                                                                                                                                             | We pay ~2× their write cost for a mechanism they measured as not worth its position |

Supporting measurements:

- Retrieval quality is **not** the bottleneck: hit@10 100%, MRR 1.0 on the
  n=50 remember corpus; session coverage 96.5% at top-20.
- The graph **neighbour walk** contributed zero to ranking in every arm and
  sits on the critical path (it runs after the vector tier resolves).
  Skipping it: 154→76 ms mean, 318→114 ms p95.
- Facts are the token-efficient representation: at matched answer accuracy,
  the fact-bearing corpus needed **1,439 tokens where raw chunks needed
  5,576** (83.3%), and **7,434 vs 11,480** (91.7%). n=12 — treat as strong
  direction, not a precise ratio.
- `preferFacts` (drop the chunk when its fact is returned — a NovaMem
  invention, not a Mem0 mechanism) was harmful in every configuration:
  facts are _lossy_ summaries and the dropped chunk carries the
  specifics. 83.3%→58.3% at top_20. Default reverted; deleted in Phase 4.
- Budget-filled retrieval returns ~127 memories in ~7,000 tokens where
  k-bounded retrieval returned 10 chunks for the same spend.
- bge-m3 beat Qwen3-Embedding-0.6B on every retrieval metric at n=50 and is
  2.1× faster. Embedding model: settled, keep bge-m3.
- Absolute cosine thresholds are not portable across embedding models
  (bge-m3 relevant 0.455–0.651 vs irrelevant 0.448–0.564 — overlapping
  bands); all "score < X is a miss" guidance was removed.

## 3. Target architecture

```
WRITE — one path. capture = remember + optional worthiness gate.
  store raw chunk (durable, immediate)  →  mark facts_pending (durable)
    └─ background reconciler (restart-safe, mirrors embedded_at):
         ONE LLM call → { facts[], entities[] }     ADD-only, hierarchical
         batch-embed facts → insert; entities → entity index
         content-hash dedup only. No decideOperation. No per-fact search.

READ — search / context
  candidates:  vector (bge-m3)  ∥  FTS keyword  ∥  entity-index lookup
    → fuse (existing) → rank prior → diversity
    → [gated experiment: cross-encoder rerank of a 3–5× pool]
    → TOKEN-BUDGET trim   (context defaults 6,000 tokens; k is a ceiling)
    → facts and chunks coexist; expandSourceChunks preserved

BACKGROUND — dream-cycle (scheduled, off every hot path)
  consolidation: cluster near-duplicate facts → batch LLM merge/supersede
    → bitemporal (asOf) edges written here, never at write time
  decay / warm-cold tiering (unchanged)
```

**Kept, because differentiating and off the hot path:** projects,
namespaces, sensitivity tiers; typed facts with `occurred_at`; bitemporal
`asOf` (moved to dream-cycle); warm/cold tiering and decay; the diagnostics
surface (`hygiene`, `evaluate`, `adoption`); `expandSourceChunks`
(historically +10pp — it hands the answerer the fact _and_ its chunk, the
opposite and correct instinct to `preferFacts`).

**Removed:** write-time supersession (`decideOperation` and the per-fact
similarity search); capture's synchronous semantic near-dup probe; the
search-time neighbour walk; `preferFacts`; the second write path's
divergent semantics.

## Phase 8 — SHIPPED AND GATED 2026-08-12: pgvector cold-store backend

**Verdict: PASS — exact accuracy parity.** LoCoMo short-run (same seed,
same 50 questions, stable table, full 378k-vector corpus resident):
pgvector (hash-partitioned) **72.0 vs Qdrant 72.0**, zero eval failures.
An earlier 62.0 read was confounded (concurrent bulk inserts into a
scope-skewed single partition) and is superseded. The bench runs
pgvector permanently per Pascal; Qdrant remains the default provider
and the scale-out option.

Shipped across #188–#192, each fixing something the gate caught live:
provider + WHERE-scope discipline (#188); hash partitioning + fast
migration tool (#189); (scope, namespace) partition key after
single-tenant skew packed all 378k vectors into one partition, plus the
deploy-trap docs (#190); ensureReady no longer memoises a failed boot
forever (#191); the PK guard survives node-pg returning name[] as a
string (#192). Migration: 378,214 vectors, 0 orphans, 17.5 minutes via
drop-index → batch-load → rebuild, vs ~5k rows/min inserting through a
global HNSW graph.

Same-day bonus (latency lever 1, #193): the FTS keyword tier's
strict-then-loose serial fallback collapsed into one statement —
measured with the tier active on the pgvector bench: p50 399→246 ms,
p95 785→476 ms. This makes re-evaluating hybrid keyword weights (which
lost the original calibration partly on latency) a live question.

## Phase 8 — original plan entry (historical; superseded by the verdict above)

Mem0's bundled server runs pgvector — vectors inside Postgres, no
separate vector service. A `pgvector` implementation behind the existing
cold-store interface would collapse NovaMem's minimum stack to
**one database + an embedder** (Qdrant becomes the optional scale-out
backend). Same discipline as Phase 7, with one difference: Qdrant
genuinely carries retrieval (unlike the graph tier), so parity is NOT
presumed. Gate: quick-gate parity on the frozen 50-question stratified reference subset (bench/ref50-qids.json) against a pgvector-backed corpus;
ingest throughput within 20% of Qdrant; measured at the 122k-chunk scale
before it may become a default anywhere.

## Benchmark ladder (adopted 2026-08-12)

1. **quick-gate** (~15 min) — read-path changes, standing corpus, no reingest.
2. **LoCoMo-10** (~45 min end-to-end incl. ingest+drain) — full-pipeline
   iteration including write-path changes; 10 conversations, published
   anchors from mem0's harness for comparability. Adapter: to be added
   to `bench/`.
3. **LongMemEval_s** (~12 h) — release gate only.

## 4. Migration plan

One variable per phase. One deploy per phase. Every gate is answer
accuracy at **n≥50** (retrieval metrics are diagnostics only — they pointed
the opposite way from answer accuracy three separate times in the
campaign). Measurements on warm pods only; no rollouts while a measurement
or ingest is in flight (a mid-drain rollout is what destroyed the n=50
corpus).

| Phase                                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Durability**                                             | `facts_pending` marker + reconciler, cloned from the `embedded_at` pattern. No behavioural change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Kill pods mid-drain → queue drains to zero after restart; 0 chunks lost. `factsPending` gauge exposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **2. Single-pass write**                                      | One LLM call emits facts+entities; write-time updation deleted (manifest below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Measured 2026-08-10:** facts/chunk −2.7% (PASS); throughput +4.4% (**FAIL as written** — the ≥2× target was miscalibrated: the 0.85 floor had already banked the updation-call savings, and the one remaining extraction call is the bottleneck); accuracy PASS on systematic analysis (3 lost vs 3 gained across replicated evals, no type pattern; top_10 +2.0pp; aggregate top_20 −6pp from borderline-question instability, tracked as Phase 3's stabilisation target).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **3. Dream-cycle consolidation**                              | Supersession + bitemporal edges move into dream-cycle as batch work (new batch-shaped prompt, not the old per-fact one).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **Measured 2026-08-10:** knowledge-update intact at 77.8% (PASS); 3,803 stale facts superseded with provenance preserved (PASS); top_20 recovery toward the P1 baseline **FAIL** — 65.0% → 65.0% with **zero systematic flips** across replicated evals. The informative result: the P1→P2 top_20 gap is _not_ caused by duplicate facts, so consolidation ships for its structural value (bounded store, `asOf` supersession trail) and the accuracy headroom question moves to Phases 4–5. Ops note: `/v1/dream-cycle` requires an admin dashboard session, so deployments using `NOVAMEM_AUTH_MODE=bearer` (a single static `Authorization: Bearer` token, no user accounts) cannot reach it at all — needs a fix in Phase 4.                                                                                                                                                                                                                                                                                             |
| **4. Read alignment + unification**                           | Entity index becomes a default candidate source; neighbour walk deleted from `search()`; `/v1/context` defaults `maxTokens=6000`; capture collapses to remember+gate; `preferFacts` deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Measured 2026-08-10 (sha-2077c14, n=50, both budgets replicated 2×): PASS.** At the deployed 6,000-token budget capture beats remember 72.0/72.0 vs 60.0/64.0 (+8–12pp, flip analysis +7/−1 with the one loss borderline); at a 1,500-token starvation probe the arms are at parity within replication noise (56–58 vs 56–62). Capture is _monotone_ in budget (1500→6000: gained 8, lost 0) while remember churns (−5/+4) — the borderline instability tracked since Phase 2 lives in the remember arm's duplicate-heavy retrieval, and the guard's dedup removes it. Knowledge-update: capture 9/9 at both budgets. Latency: harness p95 113–253 ms vs same-harness history P1=202 / P2=239 / P3=362 — no regression; the "76 ms" figure in the original gate was never this harness's class (miscalibrated target, recorded like Phase 2's throughput gate).                                                                                                                                                            |
| **5. Reranker (experiment)**                                  | Pool 3–5× budget → cross-encoder → budget trim, behind a flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **Measured 2026-08-10 (sha-8314888, n=50, both arms, 2× replicated): PASS — ADOPTED.** `bge-reranker-v2-m3` over a 4×k pool beats the Phase 4 configuration in every cell at the 6,000-token budget: remember 68/64 → 80/86, capture 70/70 → **84/82**. Flip analysis +7..+12 / −1..−2 per cell with no loss-type pattern; rerank changed the order on 50/50 questions (verified live). Capture+rerank is the campaign best: knowledge-update, single-session-user and -assistant all 100%, temporal 87.5%, multi-session 11–33% → 55.6%. Cost: search p95 ~170–240 ms → ~700 ms (cross-encoder round-trip; clipped 2,000-char docs). The prior "cross-encoder harmful" measurement was made _without_ the token-budget trim and on a different embedder — with the Phase 4 pipeline it decisively wins. Stays opt-in per request (`rerank: true`) + per deployment (`NOVAMEM_RERANK_*`); making it a server default is a deployment decision (needs a reranker service), with this gate result attached per process rule 6. |
| **6. Publish**                                                | Full 500-question LongMemEval, comparable report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **Measured 2026-08-11 (sha-80ff428): 79.4% (397/500)** on full LongMemEval_s with the adopted config (capture → vector search → bge-reranker-v2-m3 → 6,000-token budget); ablation without rerank 58.4% (+21.2pp within-harness). Answerer+judge: Qwen3.6-35B-A3B-NVFP4, thinking on, stated per the gate. Search p95 251/392 ms (ctl/rerank) on the 122k-chunk corpus. Full report with the comparability caveat (published numbers use GPT-4o-class judges): `docs/benchmarks/longmemeval-2026-08.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **7. Graph layer decision — REMOVED 2026-08-11, gate PASSED** | Decision: **remove** (not AGE-migrate). The deciding evidence: the read tier measured zero contribution (winning calibration runs graph/entity weights at 0; Phase 6's 79.4% never touched it) while FalkorDB's single-threaded writes were the measured ingest ceiling — and the engine even carried workaround code for its driver's decode bugs. AGE would spend an image change, a data migration, and a Cypher rewrite to keep a tier with no measured value. What changed: `/v1/neighbors` served by a recursive CTE over `memory_relations` (same MAX-of-path-products scoring, bitemporal filter native); relation enrichment writes SQL only, still async behind `graph_pending_at`; entity bridging deleted with its store; `weights.graph`/`weights.entity` and `health.deps.graph` kept as wire-compat no-ops; FalkorDB deleted from deps, compose, k8s manifests, and docs. Ops argument: one fewer stateful service to run, back up, monitor, and secure; relations now share Postgres durability and transactions. | **Measured 2026-08-11 (sha-510d871): PASS.** Accuracy: 82.0/80.0 on the 50-question reference subset vs the Phase 5 baseline's 84.0/82.0 — **zero systematic flips in either direction** across replications (pure parity; the graph tier really did contribute nothing). /v1/neighbors: SQL CTE serves live traffic (depth-2 smoke returns neighbours, not degraded; rewritten tests green). Writes: capture measures 0.13–0.40 s vs the 1.1 s pre-async baseline. Bench falkordb StatefulSet deleted (PVC retained for manual cleanup). The plan is complete: Phases 1–7 all measured, adopted config at 79.4% full LongMemEval_s, and the stack is one stateful service lighter.                                                                                                                                                                                                                                                                                                                                          |

Phase ordering note: Phase 2 removes write-time supersession _before_
Phase 3 adds batch consolidation. The interim state — ADD-only with
content-hash dedup — is where Mem0 lives permanently, and the Phase 3 gate
confirms nothing was lost.

## 5. Removal manifest

Rule: **a removal PR deletes the implementation, its types and schema
fields, its tests, its fakes, its docs, and its agent-facing instructions
in the same PR.** Moves are moves: the old call site dies in the PR where
the new home lands. Gate for every removal: repo-wide grep for the removed
identifiers returns zero; `tsc --noEmit` clean; full suite green.

**Phase 2 deletes**

- `engine/fact-extractor.ts`: `decideOperation()`, `OP_SYSTEM_PROMPT`,
  `OP_USER_PROMPT`, `parseOperation`, `UpdationDecision`,
  `SimilarExistingFact`
- `engine/index.ts`: the per-fact embed → `cold.search` → similar-rows →
  decide block; UPDATE/NOOP branches; `FACT_UPDATION_CANDIDATE_THRESHOLD`
- `engine/fact-updation-threshold.test.ts` (whole file — it locks a call
  that no longer exists)
- `test-fakes.ts`: the extractor stub's `decideOperation` member and its
  `Pick<>` type

**Phase 3 moves — amended after Phase 2 measurement**

- Batch LLM consolidation lands in dream-cycle (new batch-shaped
  `FactExtractor.consolidate`, cursor-walked fact slices, supersession
  metadata + bitemporal `supersedes` edges).
- The original manifest also deleted capture's write-time supersession
  here. **Amended: it stays.** The premise for moving it was LLM cost on
  the write path — but that cost was `decideOperation`, which Phase 2
  already deleted. What remains in capture is heuristic
  (`looksContradictory` / `isContentSuperset`) with the embed reused
  downstream, so the marginal sync cost is one vector query (~ms).
  Deleting it would trade tested, agent-documented, _immediate_
  contradiction handling — a behaviour Mem0 lacks — for a millisecond,
  and open a stale-fact window until the next dream-cycle run. Fails the
  "does this improve us" test on measured grounds. Phase 4's unification
  keeps the guard.

**Phase 4 deletes**

- The seeded neighbour walk inside `search()`, `GRAPH_SEED_COUNT`, and the
  walk assertions in `zero-weight-tier-skip.test.ts` (the FTS-skip
  assertions stay). `/v1/neighbors` and the `memory_neighbors` MCP tool
  survive: explicit traversal is a user-facing feature; the implicit
  search-time walk is what measured zero.
- `preferFacts`, entirely: `types.ts`, `routes/schemas.ts`, engine logic,
  and its describe-block in `token-budget.test.ts` (the `maxTokens` tests
  stay).
- The capture/remember duplication — **amended to match the Phase 3
  amendment above.** The near-dup probe itself STAYS: it is the candidate
  source for the kept contradiction/superset guard (this bullet predates
  the amendment and contradicted it as written). What Phase 4 deletes is
  the _clone_: captureInner's copy of the exact-hash dedup fast-path and
  its backfill self-heal — the block where the cross-namespace leak fix
  had to be applied twice — now delegates to remember(). One write path;
  capture = remember + guard.
- Agent-facing truth: because the guard stays, the `mcp-instructions.ts`
  promise ("capture handles near-duplicate update and contradiction
  supersession; prefer it over raw memory_remember") remains TRUE and is
  kept as-is. Repo-wide sweep for `preferFacts` / walk references in
  agent-facing docs came back clean — nothing documented either feature.

**Phase 4 additions (found running the Phase 3 gate)**

- `requireOperator` on the maintenance routes (`/v1/dream-cycle`,
  `/v1/decay`, `/v1/reap-orphans`, observer): in `bearer` auth mode the
  shared-token holder is the operator by definition, but the routes gated
  on a dashboard user that cannot exist in that mode — the Phase 3 gate
  had to drive dream-cycle from _inside the pod_. Logged-in identities
  are still role-checked (issue #45 invariant unchanged in `user` mode).
- `/v1/context` accepts `maxTokens` and defaults it to **6000** (the
  Mem0-class retrieval budget); `k` stays as a count ceiling. `/v1/search`
  stays unbounded by default — search is a query surface, context is a
  prompt-assembly surface.
- Search-time `asOf` is now a documented no-op (its only consumer was the
  walk's edge filter); the field stays accepted for wire compatibility
  and bitemporal filtering lives on `/v1/neighbors`.

No deployment env vars are tied to any removed feature. `QUERY_DECOMP` and
`OBSERVER` are opt-in features outside this plan's scope and keep working.

## 6. Process rules (the failures these encode)

1. **One variable per phase.** Two simultaneous changes (weights +
   preferFacts) cost a full measurement cycle to untangle.
2. **Answer accuracy gates; retrieval metrics are diagnostics.** Recall
   and nDCG penalised compaction by construction and mis-ranked configs
   three times.
3. **n≥50.** At n=12, config differences of one question (8.3pp) were
   repeatedly over-interpreted.
4. **Feed the answerer what the server returned.** Uniform cutoffs
   re-truncate a deliberately variable budgeted result set (this halved the
   context in one run and made a working config look broken). The harness's
   `--cutoffs all` mode exists for this.
5. **Warm pods; no rollouts during runs.** Cold-start noise produced one
   false regression; a mid-drain rollout destroyed a corpus.
6. **No unmeasured defaults.** `preferFacts` shipped default-on with no
   answer-accuracy measurement. Never again: a default changes only with a
   gate result attached.
7. **Copying Mem0 is not a gate exemption.** The reranker is theirs and
   still enters behind a flag, because our only measurement of one was
   harmful and their evidence is not our workload.
