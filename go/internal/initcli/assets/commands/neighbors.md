---
description: Graph-neighbour traversal from a NovaMem entry id
argument-hint: <seed-id> [depth=1] [k=10]
allowed-tools: mcp__novamem__memory_neighbors
---

Call `mcp__novamem__memory_neighbors` with `id: <first arg>`. If the
user passed extra positional args, parse them as `depth` and `k` (both
integers). Default `depth: 1, k: 10`.

Traversal runs over the server's SQL relations table; if that query
fails, the response carries `degraded: true` — surface that briefly.

ARGUMENTS:
$ARGUMENTS
