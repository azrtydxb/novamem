---
name: novamem
description: Persistent long-term memory via the novamem MCP server. Use when the user references prior work or past decisions, mentions a preference / convention / constraint they didn't restate this turn, asks you to remember or save something, asks what was discussed yesterday or what's stored, or you're about to make a non-trivial design call where a similar one may already exist. Covers all 17 MCP tools — hybrid search, time-windowed recall, graph traversal, store/update/forget with worthiness gate and provenance, and project (sub-brain) lifecycle including share/activate.
license: Apache-2.0
compatibility: Requires a reachable novamem MCP server (default http://localhost:7778) and a user bearer token (nm_…). See https://github.com/azrtydxb/novamem.
metadata:
  author: novamem
  version: "1.0"
  homepage: https://github.com/azrtydxb/novamem
---

# novamem · long-term memory

You have a persistent memory system through the `novamem` MCP server. It exposes hybrid retrieval (keyword + vector + graph) over durable entries the user has accumulated across sessions, plus project (sub-brain) scoping. **Use it.** Don't re-derive things the user already told you.

The server ships these same rules to compliant clients via the MCP `instructions` field on `initialize`; this skill is the equivalent for clients that don't honour `instructions`.


## Mandatory memory protocol

NovaMem is not an optional lookup tool. Use it by default:

1. **Before answering any substantive user request**, call `memory_context` with the user's current message. Substantive means technical work, planning, troubleshooting, recommendations, personal preferences, project work, or anything where prior context may change the answer. Skip only greetings/filler or when the user explicitly says not to use memory.
2. **Before asking the user to repeat context**, call `memory_context` or targeted `memory_search` first.
3. **After meaningful work**, call `memory_capture` for durable outcomes: decisions, changed preferences, verified setup facts, bug root causes, recurring constraints, or architecture invariants. Do not save secrets or transient task chatter.
4. **When a fact changed**, prefer `memory_capture` unless you already know the exact old entry id. Capture searches active nearby memories, updates near-duplicates in place, and supersedes contradictory older facts. Use `memory_update` only for manual id-targeted rewrites.

Use `memory_search` for deeper targeted recall after `memory_context`; use `memory_today`/`memory_recent` for temporal recall; use `memory_neighbors` after finding a seed memory.

## Tool map

17 MCP tools, grouped by purpose. Full detail for each group is in `references/`:

**Read / recall** — see [references/search.md](references/search.md):
- `memory_context` — first-pass grounding; relevant + recent context in one call
- `memory_search` — hybrid relevance (keyword + vector + graph fusion)
- `memory_recent` — newest-first feed, optional `since` cutoff
- `memory_today` — sugar for `recent` with a 24h window
- `memory_neighbors` — graph traversal from a seed entry id
- `memory_stats` — per-namespace + per-tier counts

**Write / mutate** — see [references/remember.md](references/remember.md):
- `memory_capture` — low-friction durable write path after meaningful work; handles semantic duplicate/update and contradiction supersession
- `memory_remember` — store a new entry (subject to the worthiness gate)
- `memory_update` — rewrite an entry in place; preserves id + hits + edges
- `memory_forget` — hard delete across warm + cold + graph

**Project (sub-brain) lifecycle** — see [references/projects.md](references/projects.md):
- `project_list` — projects you're a member of
- `project_create` — new project, you become owner
- `project_delete` — owner-only purge
- `project_activate` / `project_deactivate` — set or clear the active project; `memory_*` calls then default to it
- `project_share` / `project_unshare` — owner adds / removes members by **exact email address**

## When to call `memory_search`

Search BEFORE any of these:

- The user references prior work or a past decision
- You're about to make a non-trivial design call — a similar one may exist
- The user asks about a preference, convention, or constraint they didn't state this turn
- You're starting a task in an unfamiliar area — search before exploring blind

Default weights are tuned for prose. Useful overrides:
- `{ keyword: 1, vector: 0 }` — exact id / symbol / file / hash lookup
- `{ vector: 1, keyword: 0 }` — semantic-only (concept over literal tokens)
- `{ graph: 1 }` — neighbour-driven recall ("what's adjacent to X?")

If every hit is below ~0.4, treat it as a miss.

## When to call `memory_remember`

Save things that will still matter next session:

- Decisions with reasoning ("chose drizzle over knex because…")
- User preferences that recur (tools, formatting, review style)
- Hidden constraints (legal/compliance, deadlines, dep pins)
- Bug post-mortems (root cause + fix), not just the fix itself
- Architecture invariants the codebase wouldn't reveal on its own

Don't save:
- Conversational context that ends with the task
- Facts trivially derivable from the current code
- Anything the user said is private/secret
- Verbatim error stack traces — extract the diagnosis instead

The server applies a **worthiness gate**. Inputs shorter than 12 chars or matching the conversational-filler regex (`ok`, `thanks`, `noted`, …) are rejected with `{ rejected: <reason>, id: null }`. Pass `force: true` to bypass when the user explicitly asked for it. Exact duplicates within the same scope return `{ id: <existingId>, deduplicated: true }`; near-duplicate captures return `{ id, deduplicated: true, updated: true }`; contradictory captures return `{ id: <newId>, superseded: [<oldId>] }` and hide the old fact from normal recall. Treat all three as successful saves.

When you remember something proactively, mention it in one short sentence ("Saved that as a memory.") so the user can correct or veto.

## When to call `memory_update`

Facts evolve. If you know the exact old entry id, call `memory_update`; otherwise use `memory_capture`, which searches active nearby memories and either updates or supersedes for you. Update preserves the entry's id, hit count, and graph edges; it re-embeds when `content` changes. Skip the embedder by omitting `content` if you only need to bump metadata, provenance, or confidence.

## Provenance fields

When known, set these on `remember` and `update`:

- `sourceType` — open vocab: `chat` / `email` / `code-review` / `doc` / `inference` / `observation` / `system` / `manual`
- `capturedFrom` — agent name, conversation id, or other channel reference
- `confidence` — 0..1, default 1.0; lower for inferred facts

## Project scope (sub-brains)

A project is a *sub-brain* — its memories are a separate shelf from your user-global memory.

- When passing `project` to a `memory_*` call, an id (ULID) **or** human name both work
- Omit `project` to use whatever's currently active (or user-global if none is active)
- `includeProjects[]` (search / recent / neighbors) unions user-global with the listed projects, capped at 16

Use `project_activate({ project })` when the user signals they're working on a specific project — `memory_*` calls then default to it: `search` / `recent` / `neighbors` union it with user-global; `remember` / `forget` / `update` target it directly.

## Decay & reinforcement

Entries decay if not accessed: `effectiveDays = 7 · log₂(hits + 1)`. Searching counts as access — re-finding important memories keeps them warm. You don't need to manage this.

## Errors

- `401` — bearer missing or revoked; surface to the user, don't retry
- `degraded: true` on a search/neighbors response — graph or cold store offline; warm path still works, mention it
- `{ rejected: <reason>, id: null }` from `remember` — worthiness gate; pass `force: true` only if the user asked
- `{ id: <existing>, deduplicated: true }` from `remember` — exact duplicate; this is success, not an error
- `404 no such project` vs `403 not a member` — distinct; the former means the id/name doesn't resolve, the latter means it exists but you can't reach it
