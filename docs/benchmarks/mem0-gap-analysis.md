# Why Mem0 reports 94.4 and we report ~80 — a measured decomposition (2026-08-11)

Deep analysis of [mem0ai/mem0](https://github.com/mem0ai/mem0) (April-2026
"v3" algorithm) and their open evaluation harness
[mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks),
with every claimed factor either verified in their code or measured on our
own corpus. Short version: **the gap is not the memory system. It is the
judge, the answerer model class, and a benchmark-tuned answer prompt.**

## What their number actually is

| number | what it is |
|---|---|
| **94.4** | Their **closed managed platform** ("proprietary optimizations not available in the open-source SDK" — their README), GPT-5 answerer **and** judge |
| **91.0** | Their own reproducible OSS pipeline — still GPT-5 answering and judging |
| **88.6–89.8** | OSS with open *extraction* models — still GPT-5 answering and judging |
| **80.4 / 79.8** | NovaMem, self-hosted Qwen3.6-35B answering **and** judging, strict judge |

## The decomposition, each step measured on our own corpus

| step | overall | evidence |
|---|---|---|
| NovaMem, strict judge | **80.4** | full-500, replicated |
| + their judge style (lenient: "lean toward yes", off-by-one date amnesty, superset-correct, rubric-not-checklist) on **identical answers** | **84.8** | re-judge of all 500: 22 flips to pass, 0 to fail. Preference 76.7→93.3, single-session-user 90.0→**98.6** (compare their "98.2 assistant recall" headline) |
| + reasoning scaffold in the answer prompt (explicit date comparison; enumerate → dedupe → count; generic, no dataset rules) | **82.8 / 81.5** strict — temporal +3.0, multi-session +3.3, user +3.6 mean, both replications up | full-500 ×2 (v4). NOTE: mem0-style chronological reordering of context was ALSO tested and measured **harmful** (−2.6 temporal); scaffold adopted, reordering rejected |
| = both together: their judge style on v4 answers | **86.8** | full-500 re-judge |
| remaining ≈4 pts to their 91.0 | — | GPT-5 vs 35B answering. **77+ of our 98 v2-misses had complete evidence in the served context** (multi-session 39/41, temporal 26/28, knowledge-update 12/12) — the answerer fails to aggregate over delivered evidence, exactly the failure a frontier model buys away |
| their last ~3.4 pts (91.0→94.4) | — | closed platform; not reproducible from their code, per their own README |

Also measured: their harness's chronological date-grouped context
ordering — **harmful here** (−2.6pp temporal at full 500). Their
temporal edge is judge amnesty + model class, not ordering.

## Their pipeline vs ours — verified in code, not from the README

| | Mem0 OSS v3 | NovaMem | verdict |
|---|---|---|---|
| Write path | one LLM call, ADD-only, no update/delete | same (Phase 2) | parity — we aligned to this deliberately |
| Fact granularity | 15–80-word self-contained facts, relative dates resolved to absolute | type-tagged facts with ISO dates + source chunks kept | parity; our facts+chunks coexistence measured **better** than facts-only |
| Retrieval | **one naive search**, raw question, no rerank (off by default), additive semantic+BM25+entity fusion, top_200 into an unbounded context | hybrid + cross-encoder rerank (+21.2pp measured), 6k-token budget | **ours is stronger**; theirs leans on the answerer to sift 200 memories |
| Entity linking | spaCy NER, embedded entity vectors, boost formula | removed (Phase 7) after measuring zero contribution at our calibration | keep removed; retrieval is not our bottleneck (see evidence-full miss counts) |
| Temporal stack | **not in OSS** — `add(timestamp=)` and `search(reference_date=)` literally raise "not supported by the OSS SDK"; a regex classifier exists only to print a platform upsell notice | dates live in fact text + bitemporal relations | their published temporal capability is unverifiable |
| Consolidation | none in OSS add-path (deferred, platform-side) | dream-cycle, measured | ours exists and is measured |

## What we should and should not adopt

**Adopt (measured wins):**
1. The reasoning scaffold in the answer prompt — generic date-comparison
   + enumerate-dedupe-count instructions: **+2.1pp mean overall**
   (82.8/81.5 vs 80.4/79.8), temporal/multi-session/user all up in both
   replications. Adopted in `bench/answer_eval.py`; the same guidance
   ships in `/v1/context`.
2. **Dual-judge reporting**: publish strict (80.4) *and* their-style
   lenient (84.8) numbers. Anything else compares our strict judge to
   their "when in doubt, lean toward yes" judge and calls the difference
   an architecture gap.

**Don't adopt (measured or unverifiable):**
- BM25/entity fusion — our calibration measured vector-only + rerank
  ahead; their own harness gets away with naive retrieval only because
  top_200 + GPT-5 hides retrieval quality.
- Chronological context ordering — measured harmful here (−2.6 temporal).
- Their answer-prompt "Misc Rules" ("chandelier counts as jewelry",
  "potlucks count as dinner parties") — that is benchmark overfitting,
  not memory engineering. We decline.

## Verification round (Pascal's challenge): model and content controlled

The claims above were then verified by swapping models and harnesses with
retrieval frozen (no reingestion — the eval reruns from the stored search
reports). GPT-5 was routed through fastllm-proxy via OpenRouter.

| cell (all 500 questions, identical NovaMem corpus) | score |
|---|---|
| Qwen3-35B answer+judge, our strict prompt, k=20/6k | 80.4 → 82.8 with scaffold |
| **GPT-5** answer+judge, our strict prompt, k=20/6k | **80.4** — frontier model buys nothing under honest judging |
| GPT-5, mem0's **verbatim** harness (their overfit prompt + lenient judge), k=20/6k | 84.2 |
| GPT-5, mem0's verbatim harness, **k=100** | **90.0 (n=498)** |
| mem0's own OSS content, same harness (their published repro) | 91.0 |
| mem0 closed platform | 94.4 |

**Verdict: NovaMem's memory content is at statistical parity with mem0's
OSS v3** (90.0 vs 91.0 is ~5 questions at n=500). The published 14-point
gap decomposes as ≈4 pts prompt+judge style, ≈6 pts retrieval-window
configuration (k=20/6k vs their top_200-class window — a frontier
answerer converts width into correctness; note per-type: temporal 82.7→88.0,
multi-session 72.2→80.5, preference 83.3→100 going k=20→k=100 under
their harness), and ≈3–4 pts closed-platform opacity beyond their own
OSS repro. An earlier draft of this analysis attributed nearly
everything to the harness — the controlled cells corrected that:
the window configuration mattered as much.

**Deployment guidance that falls out:** k/maxTokens should scale with
the answerer. For a 35B self-hosted answerer our measured optimum stays
k=20/6k (wider windows were never measured to help qwen and the tight
budget is what makes it cheap); for frontier-class answerers, serve
k≈100 — the same store, one request parameter.

**The honest ceiling:** with the scaffold adopted and our judge matched
to theirs, NovaMem measures **86.8** self-hosted. The rest of the distance to
91 is buying a frontier answerer, and to 94.4 is their private platform.
If we ever want a headline-comparable number, the experiment is: our
retrieval + GPT-5-class answerer/judge via API — the memory system is
already delivering the evidence (77+/98 misses evidence-complete).

## Raw artifacts
Bench scratchpad: `runs/gate7/rejudge-lenient.json` (E3),
`runs/gate7/{tempku,msess}-v3-rep*.json` (E1/E2),
`runs/p6/answers-rr-v3-rep*.json` (full-500 confirm), agent reports in
the session task logs; cloned sources under `scratchpad/mem0` and
`scratchpad/memory-benchmarks`.
