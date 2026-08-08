# Read / recall — memory_search · memory_recent · memory_today · memory_neighbors · memory_stats

Five MCP tools for reading. All are non-mutating except `memory_search`, which counts as an access (warms hits + bumps decay).

## memory_search — hybrid relevance

Always runs keyword (FTS) + vector (cosine) + graph (neighbour) signals in parallel and fuses them with weighted scoring. Default weights `{ keyword: 0.3, vector: 0.6, graph: 0.1 }` — tuned for prose.

Inputs:
- `query` (required, string) — natural-language question or topic
- `k` (number, default 10) — top-K to return
- `namespace` (string, default `"default"`) — single shelf
- `includeNamespaces[]` (string[]) — union across shelves; capped at 16; ignores `namespace` when set
- `project` (string) — id (ULID) or human name; omit for user-global
- `includeProjects[]` (string[]) — union user-global with each listed project; capped at 16
- `weights` (object) — override one or more of `keyword` / `vector` / `graph`

Useful weight overrides:
- `{ keyword: 1, vector: 0 }` — exact id / symbol / file / hash lookup
- `{ vector: 1, keyword: 0 }` — semantic-only (concept over literal tokens)
- `{ graph: 1 }` — neighbour-driven recall

There is no model-independent "miss" threshold — the usable score range depends
on the embedding model in use. Decide from the content.

## memory_recent — time-windowed feed

Newest-first within a namespace and optional `since` lower bound. Surfacing a cold entry via `recent` does **not** auto-promote it (only `search` does); recall is non-mutating.

Inputs:
- `namespace` (string)
- `includeNamespaces[]` (string[])
- `k` (number, default 20, max 200)
- `since` (string, ISO-8601) — lower bound
- `project` (string) — id or human name
- `includeProjects[]` (string[])

## memory_today — last 24h

Sugar for `memory_recent` with `since = now - 24h` baked in. Same return shape.

Inputs:
- `namespace` (string)
- `k` (number)

## memory_neighbors — graph traversal

Walks the graph store from a seed entry id. Returns the same hit shape as `search`, scored by graph proximity.

Inputs:
- `id` (required, string) — seed entry ULID
- `depth` (number, default 1, max 3) — traversal hops; **prefer 1**, larger is exponential and noisy
- `k` (number, default 10)
- `project` / `includeProjects[]` — for entry resolution when the seed is project-scoped

If the response carries `degraded: true`, the graph store is offline — results will be empty; tell the user.

## memory_stats — snapshot

No inputs. Returns counts per namespace + tier (warm vs cold) and an overall total. Use when the user asks "how much have you remembered" or you're triaging whether the store is healthy.

## Result shape

Every hit carries:
- `id` (ULID)
- `content` (string)
- `score` (number)
- `tier` (`"warm"` | `"cold"`)
- `metadata` (object)
- per-signal sub-scores (`keyword`, `vector`, `graph`) when available
- `sourceType` / `capturedFrom` / `confidence` when set on the entry

Cite `id` if you plan to follow up with `memory_update`, `memory_forget`, or `memory_neighbors`.

## When NOT to use these

- For storing or updating facts → see `references/remember.md`
- For one-shot lookup by id → there is no `get`; use `recent` with `k=1` and grep, or just keep the id in conversation
- Don't pre-emptively search if the user is just chatting — search when their turn implies they expect you to know something durable
