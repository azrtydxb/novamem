# Write / mutate — memory.remember · memory.update · memory.forget

Three MCP tools for writing. All are subject to user + project access checks; `remember` is also subject to the worthiness gate and exact-duplicate fast-path.

## memory.remember — store a new entry

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

## memory.update — rewrite in place

When a fact changes (user moved cities, decision reversed, library swapped), call `memory.update` instead of `forget` + `remember`. Update preserves the entry's id, hit count, and graph edges; it re-embeds when `content` changes.

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
1. `memory.search` for the old phrasing to find the entry id
2. `memory.update({ id, content: <new phrasing>, confidence: 1.0 })`
3. Mention the change in one sentence

## memory.forget — hard delete

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
- `{ id: <existing>, deduplicated: true }` from `remember` — success, not an error
- `401` — bearer missing or revoked
- `403 not a member` — you tried to write to a project you can't reach
- `404 no such entry` from `update` / `forget` — id doesn't exist (or already deleted)
