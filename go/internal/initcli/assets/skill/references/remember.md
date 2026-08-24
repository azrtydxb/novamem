# Write / mutate — memory_capture · memory_remember · memory_update · memory_forget

Four MCP tools for writing. All are subject to user + project access checks. Prefer `memory_capture` for normal agent-facing durable writes: it applies the worthiness gate, exact-duplicate fast-path, semantic duplicate/update, and contradiction supersession. Use `memory_remember` only when you explicitly want raw insertion semantics plus exact dedup.

## memory_capture — preferred agent-facing write

Use after meaningful work to save one self-contained durable fact. Inputs match `memory_remember` (`content`, `namespace`, `source`, `project`, `sourceType`, `capturedFrom`, `confidence`, `force`, and optional metadata where supported by the transport).

Behaviour before inserting:

- Exact duplicate: returns `{ id, deduplicated: true }` and reinforces the existing entry.
- Near-duplicate/refinement: updates the existing active entry in place and returns `{ id, deduplicated: true, updated: true }`.
- Contradiction: inserts the new fact, marks older contradictory entries as `lifecycleStatus: "superseded"` with `supersededBy` and `supersededReason: "contradiction"`, and returns `{ id, superseded: [<oldId>, ...] }`.
- Fresh fact: inserts normally and returns `{ id }`.

Superseded/deprecated entries are hidden from normal `memory_context`/`memory_search` results. They are not hard-deleted; use `memory_forget` only when the user explicitly wants deletion.

## memory_remember — raw store a new entry

Inputs:

- `content` (required, string) — the memory text. Self-contained: assume the reader has no conversation context.
- `namespace` (string, default `"default"`) — logical shelf
- `source` (string) — origin tag (free text, e.g. agent name)
- `project` (string) — id or human name; omit for user-global, or use the active project
- `sourceType` (string) — open vocab: `chat` / `email` / `code-review` / `doc` / `inference` / `observation` / `system` / `manual`
- `capturedFrom` (string) — agent name, conversation id, or other channel reference
- `confidence` (number, 0..1, default 1.0) — lower for inferred facts
- `force` (boolean) — bypass the worthiness gate; only use when the user explicitly asked

### Worthiness gate

The server rejects content shorter than 12 chars or matching the conversational-filler regex (`ok`, `thanks`, `noted`, …). Rejection returns `{ rejected: <reason>, id: null }` — don't retry without `force: true`, and only set `force` when the user explicitly asked you to save that exact thing.

### Exact-duplicate fast-path

Entries are sha256-hashed by trimmed content. If you call `remember` with content already present in the same `(user, project)` scope, the response is `{ id: <existingId>, deduplicated: true }`. Treat that as success — the existing entry's hit count is bumped and its decay clock is refreshed.

### What to save

- Decisions with reasoning ("chose drizzle over knex because…")
- User preferences that recur (tools, formatting, review style)
- Hidden constraints (legal/compliance, deadlines, dep pins)
- Bug post-mortems (root cause + fix), not just the fix itself
- Architecture invariants the codebase wouldn't reveal on its own

### What NOT to save

- Conversational context that ends with the task
- Facts trivially derivable from the current code
- Anything the user said is private/secret
- Verbatim error stack traces — extract the diagnosis instead

### Phrasing

- Self-contained statements: "User prefers dark roast coffee" beats "yes, dark roast"
- One fact per entry — split lists into multiple `remember` calls
- Mention the save in one short sentence ("Saved that as a memory.") so the user can correct or veto

## memory_update — manual rewrite in place

When you already know the exact entry id for a changed fact, call `memory_update` instead of `forget` + `remember`. For ordinary agent captures where you do not know the old id, use `memory_capture`; it performs the retrieval/update/supersession step for you. Update preserves the entry's id, hit count, and graph edges; it re-embeds when `content` changes.

Inputs:

- `id` (required, string) — entry ULID
- `content` (string) — omit to skip re-embedding (metadata-only update)
- `namespace` (string)
- `metadata` (object)
- `sourceType` (string)
- `capturedFrom` (string)
- `confidence` (number, 0..1)
- `project` (string) — scope check; must match the entry's project (or absence)

Workflow when overriding an old fact:

1. `memory_search` for the old phrasing to find the entry id
2. `memory_update({ id, content: <new phrasing>, confidence: 1.0 })`
3. Mention the change in one sentence

If you are merely saving the new durable outcome of a task, skip the manual search and call `memory_capture` instead.

## memory_forget — hard delete

Removes the warm row, FTS row, cold vector, and any graph edges. There is no undo.

Inputs:

- `id` (required, string)

Use when:

- The user explicitly asks to forget something
- An entry is wrong and not just outdated (use `update` for outdated)
- You wrote a memory that the user vetoed in the same turn

The server enforces the project-scope boundary: if the entry belongs to a project, the caller must be a member; user-global entries can only be forgotten by the owning user.

## Errors

- `{ rejected: <reason>, id: null }` from `remember` — worthiness gate; surface and ask before retrying with `force: true`
- `{ id: <existing>, deduplicated: true }` from `remember`/`capture` — success, not an error
- `{ id: <existing>, deduplicated: true, updated: true }` from `capture` — success; near-duplicate/refinement updated the existing active entry
- `{ id: <new>, superseded: [<old>] }` from `capture` — success; older contradictory active facts are now superseded and hidden from normal recall
- `401` — bearer missing or revoked
- `403 not a member` — you tried to write to a project you can't reach
- `404 no such entry` from `update` / `forget` — id doesn't exist (or already deleted)

## Typed memory metadata

`memory_capture` and `memory_session_recap` annotate stored entries with:

- `memoryType`: `user_preference`, `setup_fact`, `project_convention`, `decision`, `bug_root_cause`, `deployment_state`, `safety_constraint`, or `general`.
- `worthiness`: `{ durable, reuseLikelihood, userRelevance, confidence, overall }`.

These fields are metadata only; they do not create a new table or migration. `memory_context` uses them to build `contextPack` sections for agents.

## Session recap ingestion

Use `memory_session_recap` at the end of meaningful work to save concise durable facts without storing the transcript. Prefer the typed arrays: `decisions`, `setupFacts`, `rootCauses`, `preferences`, `projectConventions`, and `safetyConstraints`.

## Sensitivity / privacy levels

Writes accept top-level `sensitivity`: `public`, `internal`, `private`, or `sensitive`. The value is stored as `metadata.sensitivity`. If omitted, NovaMem infers `sensitive` for obvious tokens, secrets, passwords, API keys, and bearer-like strings; otherwise it defaults to `private`.

Recall defaults to `maxSensitivity: "private"`, hiding `sensitive` memories from `memory_search`, `memory_context`, `memory_recent`, `memory_today`, and `memory_neighbors` unless the caller explicitly opts in with `maxSensitivity: "sensitive"`. Use that opt-in sparingly and never store raw secrets unless the user explicitly requires it.

`memory_update` can reclassify an entry by passing `sensitivity` without changing `content`.

## Hygiene and evaluation tools

Use `memory_hygiene` when debugging memory quality or preparing curation. It reports a `summary` count block plus low-value entries, stale current-state facts, duplicate clusters, contradiction candidates, and orphan candidates. It is read-only.

Use `memory_evaluate` to run the built-in quality harness. It returns top-level `passed`, a `summary`, detailed `cases`, and a `checks` alias for callers that expect check-oriented wording. The core suite checks supersession, context-pack grouping, junk rejection, hygiene availability, and retention policy wiring.

Use `memory_adoption` when a client may not have picked up the latest MCP tools or instructions. It returns the current tool count/names, instructions hash, feature flags, and client-specific refresh guidance. For Hermes, run `/reload-mcp`, `/reload-skills`, then `/reset` or start a fresh session.
