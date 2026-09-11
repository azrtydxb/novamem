---
title: MCP tools
---

# MCP tools

<!-- tool-catalogue:start -->

_21 tools. This section is generated from [`go/internal/mcp/tooldefs.json`](https://github.com/azrtydxb/novamem/blob/main/go/internal/mcp/tooldefs.json) by `go run ./cmd/gen-tool-docs` — the descriptions below are the ones the server sends on `tools/list`, not a paraphrase of them. Edit [`api/openapi.yaml`](https://github.com/azrtydxb/novamem/blob/main/api/openapi.yaml) and re-run `go run ./cmd/gen-contract && go run ./cmd/gen-tool-docs` — not this table, and not tooldefs.json, which is itself generated._

## Memory tools

### `memory_context`

Mandatory first-pass grounding tool. CALL THIS before answering any substantive user request. Returns relevant hybrid search results plus recent memory in one response so agents stop ignoring memory unless explicitly told.

| Argument            | Type   | Required | Description                                                                   |
| ------------------- | ------ | -------- | ----------------------------------------------------------------------------- |
| `includeNamespaces` | array  | —        | Union results across these shelves. Takes precedence over `namespace`.        |
| `includeProjects`   | array  | —        | Active-project mode: union user-global with each listed project (id or name). |
| `k`                 | number | —        | Top-K relevant/recent entries to return.                                      |
| `maxSensitivity`    | string | —        | Maximum sensitivity to return; defaults to private, excluding sensitive.      |
| `message`           | string | yes      | The user's current message or task.                                           |
| `namespace`         | string | —        | Namespace shelf to write to / read from. Omit for the caller's default shelf. |
| `project`           | string | —        | Project id or human name.                                                     |
| `weights`           | object | —        | Per-signal weight overrides. Omit to use defaults.                            |

### `memory_capture`

Low-friction durable write path. CALL THIS after meaningful work to save durable outcomes, decisions, changed preferences, verified setup facts, and root-cause lessons. Do not save secrets or transient task chatter.

| Argument       | Type    | Required | Description                                                                                                                                                                |
| -------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capturedFrom` | string  | —        | Agent name, conversation id, or other channel ref.                                                                                                                         |
| `confidence`   | number  | —        | 0..1, default 1.0                                                                                                                                                          |
| `content`      | string  | yes      | The text to store. One self-contained fact — an entry that needs its conversation to make sense is not durable.                                                            |
| `expiresAt`    | string  | —        | Explicit TTL — ISO-8601 WITH timezone offset (e.g. 2026-08-14T12:00:00Z); offset-less strings are rejected. Past it the entry is hidden from reads and later hard-deleted. |
| `force`        | boolean | —        | Bypass the worthiness gate. Default false.                                                                                                                                 |
| `metadata`     | object  | —        | Arbitrary JSON stored alongside the entry and returned with it. Not indexed for search.                                                                                    |
| `namespace`    | string  | —        | Namespace shelf to write to / read from. Omit for the caller's default shelf.                                                                                              |
| `project`      | string  | —        | Optional project (sub-brain) to scope to.                                                                                                                                  |
| `sensitivity`  | string  | —        | public \| internal \| private \| sensitive. Omitted, novamem infers sensitive for obvious secrets and private otherwise.                                                   |
| `source`       | string  | —        | Free-text origin label stored with the entry (e.g. an app or surface name).                                                                                                |
| `sourceType`   | string  | —        | chat \| email \| code-review \| doc \| inference \| observation \| system \| manual                                                                                        |

### `memory_session_recap`

Ingest a concise end-of-session recap as durable typed memories. Use this after meaningful sessions to save decisions, setup facts, root causes, preferences, project conventions, and safety constraints without dumping transcripts.

| Argument             | Type    | Required | Description                                                                                                              |
| -------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `capturedFrom`       | string  | —        | Agent name, conversation id, or other channel ref.                                                                       |
| `confidence`         | number  | —        | 0..1, default 1.0                                                                                                        |
| `decisions`          | array   | —        | Decisions reached this session, one self-contained sentence each.                                                        |
| `force`              | boolean | —        | Bypass the worthiness gate. Default false.                                                                               |
| `metadata`           | object  | —        | Arbitrary JSON stored alongside the entry and returned with it. Not indexed for search.                                  |
| `namespace`          | string  | —        | Namespace shelf to write to / read from. Omit for the caller's default shelf.                                            |
| `other`              | array   | —        | Durable items that fit none of the typed buckets above.                                                                  |
| `preferences`        | array   | —        | Preferences the user expressed, one per item.                                                                            |
| `project`            | string  | —        | Optional project (sub-brain) to scope to.                                                                                |
| `projectConventions` | array   | —        | Conventions this project follows, one per item.                                                                          |
| `rootCauses`         | array   | —        | Root causes established this session — what actually went wrong, not what was tried.                                     |
| `safetyConstraints`  | array   | —        | Constraints that must not be violated later (destructive operations, approval boundaries).                               |
| `sensitivity`        | string  | —        | public \| internal \| private \| sensitive. Omitted, novamem infers sensitive for obvious secrets and private otherwise. |
| `setupFacts`         | array   | —        | Verified environment facts: hosts, paths, versions, credentials' locations (never the credentials).                      |
| `source`             | string  | —        | Free-text origin label stored with the entry (e.g. an app or surface name).                                              |
| `sourceType`         | string  | —        | chat \| email \| code-review \| doc \| inference \| observation \| system \| manual                                      |

### `memory_hygiene`

Read-only hygiene report for memory curation: low-value entries, stale current-state candidates, duplicate clusters, contradiction candidates, and warm/cold orphan candidates.

| Argument | Type   | Required | Description                 |
| -------- | ------ | -------- | --------------------------- |
| `k`      | number | —        | Max candidates per section. |

### `memory_evaluate`

Run built-in memory quality checks covering supersession, context packs, junk rejection, hygiene availability, and retention policy wiring.

| Argument | Type   | Required | Description                          |
| -------- | ------ | -------- | ------------------------------------ |
| `suite`  | string | —        | Evaluation suite name; default core. |

### `memory_adoption`

Read-only client adoption report. Use this to verify the current MCP tool surface, instructions hash, supported feature flags, and exact refresh/reload guidance when an agent client may be using stale tools or stale instructions.

| Argument                   | Type   | Required | Description                                                                     |
| -------------------------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `client`                   | string | —        | Client name, e.g. hermes, claude-code, claude-desktop, codex, cursor.           |
| `observedInstructionsHash` | string | —        | Optional sha256 hash of the instructions observed by the caller.                |
| `observedTools`            | array  | —        | Optional tools/list names observed by the caller for stale-surface diagnostics. |

### `memory_search`

Search the user's persistent memory store for facts about them. CALL THIS PROACTIVELY at the start of any conversation where personal context might matter — preferences, project context, biographical details, prior decisions. Do not wait for the user to remind you they've stored something. If the user references "my project", "what I told you", "as we discussed", "the same as before", or any personal context that isn't already in this conversation, search here FIRST before asking them to repeat. This store contains facts the user has explicitly chosen to persist, so its contents are higher-confidence than inferences from your built-in conversation memory or `memory_user_edits`. Hybrid keyword (FTS) + vector (cosine) + graph (neighbours) fused via weighted scoring (defaults keyword 0.3, vector 0.6, graph 0.1). Override `weights` only with a specific reason — e.g. `{ keyword: 1, vector: 0 }` for exact-id / symbol lookup, or `{ vector: 1, keyword: 0 }` to ignore literal overlap and lean fully on semantic similarity.

| Argument            | Type   | Required | Description                                                                                                                                                                                                        |
| ------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contentMode`       | string | —        | "snippet" truncates content to ~240 chars (truncated: true on cut rows); "ids" omits content and metadata (rank first, hydrate later). Default "full".                                                             |
| `includeNamespaces` | array  | —        | Cross-namespace search: union results across these shelves. Takes precedence over `namespace`. Use to _restrict_ the default fanout to a specific subset; if you want everything, omit both fields.                |
| `includeProjects`   | array  | —        | Active-project mode: union user-global with each listed project (id or name).                                                                                                                                      |
| `k`                 | number | —        | Top-K to return (default 10)                                                                                                                                                                                       |
| `namespace`         | string | —        | Single namespace shelf to search. Overridden by `includeNamespaces` when both are set. Omit both to fan out across every namespace with entries visible in the current scope (user-global and/or active projects). |
| `project`           | string | —        | Project to scope to. Accepts id (ULID) or human name. Omit for user-wide entries.                                                                                                                                  |
| `query`             | string | yes      | What to search for, in natural language. Hybrid retrieval fuses keyword, vector, graph, recency and entity signals over it.                                                                                        |
| `weights`           | object | —        | Per-signal weight overrides. Omit to use defaults.                                                                                                                                                                 |

### `memory_remember`

Store a personal fact about the user in their persistent memory store. USE THIS FOR ALL personal facts the user asks you to remember: preferences (favourite tools, foods, response style), biographical info (location, role, family), project context (what they're building, what stack they use), recurring tasks, communication preferences, and anything the user says with phrases like "remember", "don't forget", "save this", "please remember that", "for future reference", "keep this in mind", or "note that". This is the user's primary memory system and TAKES PRECEDENCE OVER `memory_user_edits` for any user-specific content. Use `memory_user_edits` only for routing rules about your own behaviour (e.g. "always respond in French") — not for facts about the user. When in doubt between the two, use this tool. Pass `project` to scope the fact to a sub-brain; omit for user-wide facts that should apply across all contexts. The worthiness gate rejects content under 12 chars or filler ("ok", "thanks"); pass `force: true` only when the short content is a deliberate anchor (id, version pin, phone number).

| Argument       | Type    | Required | Description                                                                                                                                                                |
| -------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capturedFrom` | string  | —        | Agent name, conversation id, or other channel ref.                                                                                                                         |
| `confidence`   | number  | —        | 0..1, default 1.0                                                                                                                                                          |
| `content`      | string  | yes      | The text to store. One self-contained fact — an entry that needs its conversation to make sense is not durable.                                                            |
| `expiresAt`    | string  | —        | Explicit TTL — ISO-8601 WITH timezone offset (e.g. 2026-08-14T12:00:00Z); offset-less strings are rejected. Past it the entry is hidden from reads and later hard-deleted. |
| `force`        | boolean | —        | Bypass the worthiness gate. Default false.                                                                                                                                 |
| `namespace`    | string  | —        | Namespace shelf to write to / read from. Omit for the caller's default shelf.                                                                                              |
| `project`      | string  | —        | Optional project (sub-brain) to scope to.                                                                                                                                  |
| `source`       | string  | —        | Free-text origin label stored with the entry (e.g. an app or surface name).                                                                                                |
| `sourceType`   | string  | —        | chat \| email \| code-review \| doc \| inference \| observation \| system \| manual                                                                                        |

### `memory_today`

Surface what the user has worked on today. CALL THIS AT THE START OF A NEW CONVERSATION when the user asks "what was I doing", "where did we leave off", "recap", "what's new today", "catch me up" — or proactively at session start to ground yourself in the user's current focus before answering anything substantive. Returns the last 24 h of entries newest-first. Cheaper than a full search when the user's question is about _recent_ state. Combine with `memory_search` when the question spans further back than today.

| Argument            | Type   | Required | Description                                                                                                                                            |
| ------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contentMode`       | string | —        | "snippet" truncates content to ~240 chars (truncated: true on cut rows); "ids" omits content and metadata (rank first, hydrate later). Default "full". |
| `includeNamespaces` | array  | —        | Union results across these shelves. Takes precedence over `namespace`.                                                                                 |
| `includeProjects`   | array  | —        | Active-project mode: union user-global with each listed project (id or name).                                                                          |
| `k`                 | number | —        | How many entries to return.                                                                                                                            |
| `maxSensitivity`    | string | —        | Maximum sensitivity to return; defaults to private, excluding sensitive.                                                                               |
| `namespace`         | string | —        | Namespace shelf to write to / read from. Omit for the caller's default shelf.                                                                          |
| `project`           | string | —        | Project id or name.                                                                                                                                    |

### `memory_recent`

Time-bounded feed of memory entries newest-first. USE THIS when the user asks "what have I been working on lately", "this week", "this month", "since [date]", "what changed after X". Pass `since` as ISO-8601 to set the lower bound; without it, returns the latest entries unbounded. This is the right tool when the question is _temporal_; use `memory_search` when the question is about a _topic_; use `memory_today` for the 24 h convenience window. All three are cheap — pick the one whose framing fits the user's phrasing.

| Argument            | Type   | Required | Description                                                                                                                                            |
| ------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contentMode`       | string | —        | "snippet" truncates content to ~240 chars (truncated: true on cut rows); "ids" omits content and metadata (rank first, hydrate later). Default "full". |
| `includeNamespaces` | array  | —        | Cross-namespace recent feed.                                                                                                                           |
| `includeProjects`   | array  | —        | Active-project mode: union user-global with each listed project (id or name).                                                                          |
| `k`                 | number | —        | How many entries to return.                                                                                                                            |
| `namespace`         | string | —        | Namespace shelf to write to / read from. Omit for the caller's default shelf.                                                                          |
| `project`           | string | —        | Project id or name.                                                                                                                                    |
| `since`             | string | —        | ISO-8601 timestamp                                                                                                                                     |

### `memory_neighbors`

Walk graph edges from a known memory id to its strongly-linked neighbours. CALL THIS WHEN you've already found one relevant memory via `memory_search` and want adjacent context that the user may have stored alongside it but didn't mention by name — supporting decisions, prior incidents, related ADRs, the rest of a cluster of related facts. Best for "why did we make decision X", "what was the context around Y", "what's connected to this". Depth 1 is the hot path (default); 2 and 3 walk further but cost more. Pass the seed `id` returned by a previous search/recent call. Use this as a _follow-up_ to `memory_search`, not as a first-pass tool.

| Argument          | Type   | Required | Description                                                                   |
| ----------------- | ------ | -------- | ----------------------------------------------------------------------------- |
| `depth`           | number | —        | Traversal depth (default 1)                                                   |
| `id`              | string | yes      | Seed memory id (ULID) to walk out from.                                       |
| `includeProjects` | array  | —        | Active-project mode: union user-global with each listed project (id or name). |
| `k`               | number | —        | How many entries to return.                                                   |
| `project`         | string | —        | Project id or name (for entry resolution).                                    |

### `memory_forget`

Permanently delete a memory entry. USE THIS ONLY when the user explicitly asks to forget, delete, remove, or scrub something — phrases like "forget that", "delete the entry about X", "remove what I said about Y", "that's wrong, drop it". Do NOT call this proactively or as a way to "clean up" the store; the synaptic-decay sweep handles natural-aging. If a fact CHANGED rather than became wrong, call `memory_update` instead — preserves id, hit count, and graph edges. Idempotent: a second call on a deleted id returns `deleted: false` cleanly.

| Argument  | Type   | Required | Description                                                                                                |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `id`      | string | yes      | Memory id (ULID) to delete permanently. Idempotent: deleting an id that is already gone still answers 200. |
| `project` | string | —        | Project id or name (scope check).                                                                          |

### `memory_update`

Rewrite an existing memory in place when a fact about the user has CHANGED. USE THIS — not forget+remember — when the user says "actually, I moved", "that's outdated", "correction", "I switched to X now", "I no longer use Y", "update what you have on Z". Preserves id, hit count, graph edges, and creation date — so the new content keeps every connection the original had. forget+remember would lose all of that. Omit `content` to update only metadata-side fields (sourceType, confidence, capturedFrom) without re-embedding. If you're not sure whether the old fact still applies somewhere else, search first to find related entries that may also need updating.

| Argument       | Type   | Required | Description                                                                                                              |
| -------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `capturedFrom` | string | —        | Agent name, conversation id, or other channel ref.                                                                       |
| `confidence`   | number | —        | 0..1                                                                                                                     |
| `content`      | string | —        | Replacement text. The id, its graph edges and its hit count survive the rewrite.                                         |
| `id`           | string | yes      | Memory id (ULID).                                                                                                        |
| `metadata`     | object | —        | Arbitrary JSON stored alongside the entry and returned with it. Not indexed for search.                                  |
| `namespace`    | string | —        | Namespace shelf to write to / read from. Omit for the caller's default shelf.                                            |
| `project`      | string | —        | Project id or name (scope check).                                                                                        |
| `sensitivity`  | string | —        | public \| internal \| private \| sensitive. Omitted, novamem infers sensitive for obvious secrets and private otherwise. |
| `sourceType`   | string | —        | chat \| email \| code-review \| doc \| inference \| observation \| system \| manual                                      |

### `memory_stats`

Diagnostic snapshot of the user's memory store. CALL THIS only when the user asks "how much have I stored", "how many memories do I have", "is my store healthy", or when troubleshooting why search results seem incomplete. Returns byNamespace warm/cold entry counts, totals, and service-wide lastDecayAt + uptimeMs as context. This is NOT a primary tool — don't call it before normal search/remember operations. Useful as a sanity check before bulk operations or when the user reports unexpected results.

Takes no arguments.

## Project tools

### `project_list`

List the projects (sub-brains) the user belongs to. CALL THIS PROACTIVELY whenever the user mentions "my project", "the X project", "the team workspace", or any project-by-name reference you don't already know the id for — instead of asking the user to clarify which project they mean, list them and disambiguate yourself. Also call before `project_activate`, `project_share`, or `project_unshare` if the user used a name and you want to confirm it exists / spell it correctly. Returns id + name + role (owner/member) per project.

Takes no arguments.

### `project_create`

Create a new project (sub-brain) — a shared scope of memory the user can later invite teammates to. USE THIS when the user says "start a new project", "create a workspace for X", "I'm starting work on Y", "new sub-brain", "set up a memory bucket for the Z initiative". The user becomes owner automatically. Pick a clear, short name — the user will see it in the dashboard switcher. Don't create projects unprompted; if the user just mentions working on something, ask first whether they want a dedicated project or whether a namespace within their user-global store is enough. The server assigns a ULID — you don't pick the id.

| Argument | Type   | Required | Description                 |
| -------- | ------ | -------- | --------------------------- |
| `name`   | string | yes      | Project name (1-128 chars). |

### `project_delete`

PERMANENTLY delete a project and every memory entry inside it. Cascades through warm rows, FTS, cold-tier Qdrant collections, and graph nodes — irreversible. CALL THIS ONLY after the user has explicitly confirmed: phrases like "yes delete the X project", "go ahead and remove it permanently", "trash the whole project". If the user just says "delete X" without confirming consequences, ask first — once. Owner-only; if the user is a member but not owner, they should `project_unshare` themselves (or be unshared by the owner). Accepts id or name; the server resolves names automatically. Mention how many entries / collections / edges were removed in your reply so the user has receipts.

| Argument  | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `project` | string | yes      | Project id or human name. |

### `project_activate`

Pin the user's active project so subsequent `memory_*` calls default to that scope without you having to pass `project` every time. CALL THIS when the user says "let's work on X", "switch to project Y", "focus on Z for the rest of this session", "context me into X". Reads (search / recent / today / neighbors) union the active project with user-global. Writes (remember / forget / update) target the active project directly — so a remember call no longer lands in user-global by default. Server-side state, persists across SSE reconnects. Idempotent.

| Argument  | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `project` | string | yes      | Project id or human name. |

### `project_deactivate`

Clear the active-project pin so subsequent `memory_*` calls fall back to user-global only. CALL THIS when the user says "back to global", "context out", "clear active project", "back to my personal store", "no project for now". Also call when the user pivots away from the current project context to discuss something unrelated and they don't want new memories landing in the old project's scope. Idempotent — safe to call when nothing's active.

Takes no arguments.

### `project_share`

Invite another user to a project the user owns — gives them read AND write access to every entry in it. CALL THIS when the user says "share X with bob", "add alice to my project", "give the team access", "invite [user] to Y". Owner-only — if the calling user is just a member, surface that and tell them to ask the owner. Use the invitee's exact email address — display names are self-settable and therefore not accepted as an identifier here. Confirm the email back in your reply ("added alice@example.com to mcp-fulltest") so the user catches typos. The invitee will see the project in their dashboard switcher immediately — no email is sent.

| Argument   | Type   | Required | Description                             |
| ---------- | ------ | -------- | --------------------------------------- |
| `project`  | string | yes      | Project id or human name.               |
| `username` | string | yes      | Exact email address of the user to add. |

### `project_unshare`

Revoke a member's access to a project. CALL THIS when the user says "remove bob from X", "unshare alice", "kick [user] off Y", "revoke their access". Effective immediately — the removed user's next request scoped to the project will 403. The owner cannot unshare themselves; if the user wants to abandon a project they own, use `project_delete` instead (cascade-deletes everything) or transfer ownership first (planned, not yet implemented). Members can unshare themselves to leave the project — they don't need owner permission.

| Argument   | Type   | Required | Description                                |
| ---------- | ------ | -------- | ------------------------------------------ |
| `project`  | string | yes      | Project id or human name.                  |
| `username` | string | yes      | Exact email address of the user to remove. |

<!-- tool-catalogue:end -->

## Transports

Three equivalent paths:

### Streamable HTTP — recommended for new clients

The current MCP spec (2025-03-26). Single endpoint, content-negotiated:

```
POST   /mcp   — JSON-RPC requests; `initialize` without Mcp-Session-Id starts a session
GET    /mcp   — opens server→client SSE channel for an existing session
DELETE /mcp   — terminates a session
```

Connect with `Authorization: Bearer nm_…`. Session id is returned in the `Mcp-Session-Id` response header on the initialize POST and must be echoed on every subsequent request. Session ownership is bound to the bearer holder — a leaked session id can't be driven by a different authenticated user.

What clients speak this transport: OpenAI Codex CLI, recent Cursor / Kilo Code (auto-detect with SSE fallback), GitHub Copilot in VS Code, anything built on the Rust `rmcp` crate.

### Legacy HTTP+SSE — removed

`GET /mcp/sse` + `POST /mcp/messages?sessionId=…` was the two-endpoint transport from protocol revision `2024-11-05`. The spec [Deprecated it](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) in `2025-03-26`, and novamem removed it (ADR 0007). Both paths now answer the 404 envelope.

Everything it served is served by `/mcp`, which speaks both protocol eras. A client still configured for the old pair needs its `url` changed to `/mcp` and its `type` to `http`; `novamem-init` writes that shape now.

### stdio shim

`novamem-mcp` proxies stdio JSON-RPC ↔ Streamable HTTP. Used by hosts that don't support remote MCP at all (Claude Desktop) or whose remote-MCP implementation is broken.

```bash
NOVAMEM_BASE_URL=https://novamem.example.com \
NOVAMEM_TOKEN=nm_... \
  npx -y @azrtydxb/novamem-mcp
```

Pin the version (`@1.2.0`) for reproducibility.

## Conventions

- All ids are ULIDs (`01H…`), 26 chars.
- Timestamps are ISO-8601 with a `Z` suffix.
- Optional fields default to sensible values; the server documents the defaults via the OpenAPI spec.
- Errors come back as MCP `error` responses with a structured shape; the dashboard / CLI shows the human message.

## See also

- [Mental model](../concepts/mental-model.md)
- [Hybrid search internals](../architecture/hybrid-search.md)
- [novamem-init CLI](../connect/init-cli.md) — wires the SSE/stdio config for you
