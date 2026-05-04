---
description: Graph-neighbour traversal from a NovaMem entry id
argument-hint: <seed-id> [depth=1] [k=10]
allowed-tools: mcp__novamem__memory_neighbors
---

Call `mcp__novamem__memory_neighbors` with `id: <first arg>`. If the
user passed extra positional args, parse them as `depth` and `k` (both
integers). Default `depth: 1, k: 10`.

Render hits as `id  weight  tier  one-line content`. If FalkorDB is
degraded, the response carries `degraded: true` — surface that briefly.

ARGUMENTS:
$ARGUMENTS
