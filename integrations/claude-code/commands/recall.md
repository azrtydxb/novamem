---
description: Hybrid-search NovaMem memories (keyword + vector + graph)
argument-hint: <query>
allowed-tools: mcp__novamem__memory_search
---

Search NovaMem by calling `mcp__novamem__memory.search` with the query
below. Use defaults unless the query strongly hints otherwise:

- If the query is a literal id, symbol, or hash, pass
  `weights: { keyword: 1, vector: 0 }`.
- If the user asks for "anything related to / similar to / like X",
  pass `weights: { vector: 1, keyword: 0 }`.

Cap at `k: 10`. Show results compactly: id (short hash), score, tier,
1-line content excerpt. If every score < 0.4, say "no strong matches"
and stop — don't pad with low-confidence hits.

QUERY:
$ARGUMENTS
