---
title: Data plane
---

# Data plane

The twelve core operations that AI agents call. Same endpoints whether you're on the bearer-token route (`/v1/*`) or the cookie-session mirror (`/v1/me/*`).

## `POST /v1/context`

Low-friction first-pass grounding for the current user message. Intended as the first call before substantive agent work. It returns relevant hybrid search results, recent memories, and a structured `contextPack` grouped by memory type and scope (`userGlobal` vs `projectScoped`) in one response.

```json
{
  "message": "user request or task summary",
  "namespace": "default",
  "includeNamespaces": ["..."],
  "k": 10,
  "project": "id or name",
  "includeProjects": ["..."],
  "maxSensitivity": "public|internal|private|sensitive"
}
```

Returns `{ relevant, recent }` with the same result shape used by search/recent.

## `POST /v1/search`

Hybrid retrieval. Always runs keyword + vector + graph in parallel, fuses with weighted scoring.

```json
{
  "query": "string (required)",
  "k": 10,
  "namespace": "single shelf to search",
  "includeNamespaces": ["restrict fanout to subset"],
  "project": "id or name",
  "includeProjects": ["active-project union"],
  "weights": { "keyword": 0.3, "vector": 0.6, "graph": 0.1 },
  "agentName": "filter results to entries authored by this agent",
  "maxSensitivity": "public|internal|private|sensitive"
}
```

`maxSensitivity` defaults to `private`, which returns `public`, `internal`, and `private` entries while excluding `sensitive` entries unless explicitly requested.

Returns `{ results: SearchResult[], degraded: boolean }`. Each result has `id, score, content, tier, namespace, project, source, metadata, signals`.

## `POST /v1/capture`

Preferred agent-facing durable write after meaningful work. Same input shape as `remember`, but with semantic duplicate/update and contradiction supersession before insert.

```json
{
  "content": "required, self-contained durable fact",
  "namespace": "default",
  "source": "agent name or origin",
  "sourceType": "doc|chat|email|code-review|inference|observation|system|manual",
  "capturedFrom": "conversation / run / channel ref",
  "confidence": 1.0,
  "agentName": "agent identifier",
  "project": "id or name",
  "metadata": {},
  "sensitivity": "public|internal|private|sensitive",
  "force": false
}
```

Responses:

- `{ id }` — inserted a fresh fact.
- `{ id, deduplicated: true }` — exact duplicate, existing entry reinforced.
- `{ id, deduplicated: true, updated: true }` — near-duplicate/refinement, existing active entry updated in place.
- `{ id, superseded: ["01..."] }` — new fact inserted and older contradictory active entries marked superseded.
- `{ id: null, rejected: "<reason>" }` — worthiness gate rejected the content.

Superseded entries are marked in metadata and hidden from normal search/context results; they are not hard-deleted.

Captured entries are also annotated with typed metadata when possible:

- `memoryType`: `user_preference`, `setup_fact`, `project_convention`, `decision`, `bug_root_cause`, `deployment_state`, `safety_constraint`, or `general`.
- `worthiness`: v2 scoring object with `durable`, `reuseLikelihood`, `userRelevance`, `confidence`, and `overall`.
- `retention`: memory-type policy such as `long_lived`, `medium`, `current_only`, plus `baseEffectiveDays` and `supersedeAggressively`.
- `sensitivity`: privacy classification. Explicit `sensitivity` wins; otherwise NovaMem infers `sensitive` for obvious token/secret/password/API-key content and defaults to `private`.

## `POST /v1/session-recap`

Batch ingest a curated end-of-session recap without dumping transcripts. The route accepts arrays such as `decisions`, `setupFacts`, `rootCauses`, `preferences`, `projectConventions`, `safetyConstraints`, and `other`, then stores each item through the same `capture` path with the appropriate `memoryType`.

Use this for durable outcomes after meaningful work: final deployment state, root causes, user preferences, and decisions. Do not pass raw chat logs or secrets.

## `POST /v1/hygiene`

Read-only memory hygiene report for curation and debugging. The response includes a `summary` count block plus candidate lists for:

- `lowValue` — low worthiness / too-short entries
- `stale` — current-state facts worth review
- `duplicateClusters` — high-overlap active memories
- `contradictionCandidates` — comparable scalar conflicts not yet superseded
- `orphanCandidates` — warm entries missing a cold/vector counterpart

## `POST /v1/evaluate`

Run built-in memory quality checks. The response includes `passed`, `summary`, `cases`, and a compatibility `checks` alias. The core suite verifies that newer facts supersede older facts, context packs group typed memories, junk captures are rejected, hygiene reports are available, and retention policies are wired.


## `POST /v1/adoption`

Read-only client adoption and refresh report. Use this when an MCP/agent client may be using stale tools or stale instructions after a server, shim, or skill update.

```json
{
  "client": "hermes",
  "observedTools": ["memory_context", "memory_capture"],
  "observedInstructionsHash": "optional sha256"
}
```

Returns the current server-side MCP tool manifest, tool count, required adoption tools, MCP instructions hash, feature flags, client-specific refresh commands, and diagnostics. For Hermes, the refresh sequence is `/reload-mcp`, `/reload-skills`, then `/reset` or a fresh session.

## `POST /v1/remember`

Raw write of a new entry. Worthiness gate + exact SHA dedup applied. For normal agent saves, prefer `/v1/capture`, which also handles semantic near-duplicates and contradiction supersession.

```json
{
  "content": "required, 1-256KB",
  "namespace": "default",
  "source": "cli|web|...",
  "sourceType": "doc|chat|email|code-review|inference|observation|system|manual",
  "capturedFrom": "agent / channel ref",
  "confidence": 1.0,
  "agentName": "agent identifier",
  "project": "id or name",
  "metadata": {},
  "sensitivity": "public|internal|private|sensitive",
  "force": false
}
```

Response: `{ id }` on success, `{ id: null, rejected: "<reason>" }` on gate failure, `{ id, deduplicated: true }` on exact duplicate.

## `POST /v1/recent`

Newest-first feed.

```json
{
  "namespace": "default",
  "includeNamespaces": ["..."],
  "k": 20,
  "since": "ISO-8601 lower bound",
  "project": "...",
  "includeProjects": ["..."],
  "maxSensitivity": "public|internal|private|sensitive"
}
```

`memory_today` is `recent` with a 24 h `since`.

## `POST /v1/neighbors`

Graph traversal from a seed entry id.

```json
{
  "id": "ULID, required",
  "depth": 1,
  "k": 20,
  "project": "..."
}
```

`depth` is allowlisted to `{1, 2, 3}`. `maxSensitivity` defaults to `private`, which returns `public`, `internal`, and `private` entries while excluding `sensitive` entries unless explicitly requested.

Returns `{ results: SearchResult[], degraded: boolean }`. Path-product aggregation along multi-hop walks.

## `POST /v1/forget`

Hard delete.

```json
{ "id": "ULID, required", "project": "scope check" }
```

Cascades: warm row + FTS shadow + cold vector + graph node + edges. Returns `{ deleted, coldDeleteOk }`. Idempotent — second call returns `{deleted: false}`.

## `POST /v1/update`

In-place rewrite. Preserves id, hits, edges, creation date. Re-embeds content if `content` is provided.

```json
{
  "id": "ULID, required",
  "content": "new content (optional — omit to update only metadata)",
  "namespace": "...",
  "metadata": {},
  "sourceType": "...",
  "capturedFrom": "...",
  "confidence": 0.9
}
```

Returns `{ updated, embeddingChanged }`.

## `GET /v1/stats`

Per-caller statistics: byNamespace warm/cold counts, totals, last decay run.

## Errors

Every route returns:

- `400` — Zod validation failure with the path that failed
- `401` — missing / invalid bearer
- `403` — bearer scope mismatch (e.g. project-pinned token accessing another project)
- `404` — entry / project not found
- `429` — rate limit
- `500` — engine error (logged, body has a generic message)

## See also

- [MCP tools](/api/mcp-tools) — same operations exposed over MCP
- [Hybrid search internals](/architecture/hybrid-search) — what the `weights` knob does
