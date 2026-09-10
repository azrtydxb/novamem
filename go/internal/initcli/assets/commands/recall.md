---
description: 5-signal hybrid retrieval (keyword + vector + graph + recency + entity, graph/entity at 0 in production calibration)
argument-hint: <query>
allowed-tools: mcp__novamem__memory_search
---

Search NovaMem by calling `mcp__novamem__memory_search` with the query
below. Use defaults unless the query strongly hints otherwise:

- If the query is a literal id, symbol, or hash, pass
  `weights: { keyword: 1, vector: 0 }`.
- If the user asks for "anything related to / similar to / like X",
  pass `weights: { vector: 1, keyword: 0 }`.

Cap at `k: 10`. Show results compactly: id (short hash), score, tier,
1-line content excerpt. If nothing in the returned content actually answers the
query, say "no strong matches" and stop — don't pad with irrelevant hits. Don't
gate on an absolute score: the usable range is model-dependent.

QUERY:
$ARGUMENTS
