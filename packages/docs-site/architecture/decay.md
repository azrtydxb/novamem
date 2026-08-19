---
title: Decay & dream cycle
---

# Decay & dream cycle

Two background processes keep the warm tier from growing unbounded.

## Synaptic decay

Every `NOVAMEM_DECAY_INTERVAL_MS` (default 6 h) the engine sweeps `memory_entries` and demotes anything past its effective lifespan to cold-only:

```
effectiveDays(hits) = NOVAMEM_DECAY_DAYS · log₂(hits + 1)
```

| Hits | effectiveDays                                    |
| ---- | ------------------------------------------------ |
| 0    | 0 (rare; entries seeded with hits=1 by remember) |
| 1    | 7                                                |
| 3    | 14                                               |
| 7    | 21                                               |
| 15   | 28                                               |
| 31   | 35                                               |
| 1023 | 70                                               |

Demotion is cheap: `markCold(id, true)` flips a flag and the entry stops appearing in keyword search. The vector copy in Qdrant is unchanged — that's still the cold-tier source. The graph node is unchanged.

## Reactive promotion

A search hit on a cold-only entry can promote it back to warm if its accumulated lifespan now exceeds its idle days:

```ts
if (effectiveDays(preBump.hits + 1) > preBump.idleDays) {
  await this.warm.markCold(id, false);
  this.metrics?.recordPromotion();
}
```

Without this check, any incidental match would promote — defeating the decay maths. The pre-bump stat read ensures a fresh hit doesn't reset the clock against itself.

## Dream cycle

A nightly compaction job (cron-style, configurable via `NOVAMEM_DREAM_INTERVAL_MS`) runs two passes:

### Dedup (cosine + Jaccard)

For each entry pair within a scope:

1. Compute `cosine(embedding_a, embedding_b)`.
2. If `cosine ≥ 0.97`, also compute `tokenJaccard(content_a, content_b)`.
3. If `jaccard ≥ 0.5`, merge: keep the older entry, transfer hits from the newer one, delete the newer.

Both gates are required. Cosine alone is fooled by contradictions ("Pascal lives in Dubai" / "Pascal lives in Belgium" — both about Pascal's location, similar vectors). Jaccard's stop-word-filtered token overlap forces the two to share content words, not just structure.

### Edge promotion

For nodes with ≥ 3 shared neighbours, add a direct edge between them. Strengthens emergent clusters in the graph; the next graph-tier search hits these stronger paths.

## Manual decay

Operator endpoint:

```bash
curl -X POST https://novamem.example.com/v1/decay \
  -H "Authorization: Bearer ns_..."
```

Useful right after import / migration when many entries are stale.

## Why decay at all?

Without decay, every entry stays warm forever. The warm tier (Postgres) becomes the entire memory; cold (Qdrant) is empty; the tiered architecture collapses. Decay is what makes "tiered" load-bearing — recent + frequent stays fast; everything else is still recallable but doesn't drag down the hot path.

## Source

[`go/internal/engine/`](https://github.com/azrtydxb/novamem/blob/main/go/internal/engine/) — decay, promotion and the dream cycle (`jobs.go`, `dream.go`).
