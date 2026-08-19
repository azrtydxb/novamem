# @azrtydxb/novamem

TypeScript client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service with 5-signal hybrid retrieval (keyword + vector + graph + recency + entity), content-hash dedup, sensitivity auto-detection, and async background enrichment.

```bash
npm install @azrtydxb/novamem
```

## Quickstart

```ts
import { NovamemClient } from "@azrtydxb/novamem";

const memory = new NovamemClient({
  baseUrl: "http://localhost:7778",
  token: process.env.NOVAMEM_TOKEN, // user bearer `nm_…`
});

await memory.remember({ content: "User prefers dark roast" });
const hits = await memory.search({ query: "coffee preference", k: 5 });
```

A `nm_…` bearer carries every right the owning user has — the user's whole memory plus every project they're a member of. Mint one from the dashboard's API Tokens page.

## Project-scoped operations

Each entry can belong to a **project** (sub-brain). Pass `project` (id or human name) to scope:

```ts
await memory.remember({ content: "phoenix sprint plan", project: "Phoenix" });
await memory.search({ query: "sprint", project: "Phoenix" });
```

When the user has an active project set (`setActiveProject`), memory\_\* calls without an explicit `project` arg default to it: search/recent/neighbors union user-global with the active project; remember/forget/update target the active project directly.

## Memory.update — rewriting facts

When a fact changes (user moved cities, decision reversed, …) update the existing entry instead of forget+remember; preserves the entry's id, hit count, and graph edges.

```ts
const oldId = "01KQ…";
await memory.updateMemory(oldId, {
  content: "User profile: Pascal Watteel lives in Singapore.",
  confidence: 1.0,
});
```

## API surface

### Memory data plane

| Method                  | Description                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search(req)`           | 5-signal hybrid retrieval (keyword + vector + graph + recency + entity)                                                                                           |
| `capture(req)`          | Agent-facing durable write with typed metadata, worthiness scoring, semantic dedupe/update, and supersession                                                      |
| `sessionRecap(req)`     | Batch ingest curated end-of-session recap items                                                                                                                   |
| `hygiene(req)`          | Read-only memory hygiene report                                                                                                                                   |
| `evaluate(req)`         | Run built-in memory quality evaluation scenarios                                                                                                                  |
| `remember(req)`         | Store a new entry; subject to the worthiness gate (pass `force: true` to bypass)                                                                                  |
| `updateMemory(id, req)` | Rewrite an entry in place; preserves id + hits + edges                                                                                                            |
| `recent(opts)`          | Newest entries by namespace                                                                                                                                       |
| `today(opts)`           | Last-24h entries (sugar over `recent`)                                                                                                                            |
| `neighbors(opts)`       | Graph-neighbour traversal from a seed id                                                                                                                          |
| `forget(id, opts?)`     | Hard delete                                                                                                                                                       |
| `stats()`               | Per-namespace counts                                                                                                                                              |
| `health()`              | Public liveness probe — returns `{ ok }` only. Per-dependency status lives behind the admin-gated `/v1/admin/health/deep` route, which the client does not expose |
| `decay(opts?)`          | Run the warm→cold demotion pass on demand                                                                                                                         |

### Projects

| Method                                        | Description                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `listProjects()`                              | Projects the user is a member of                                                                                      |
| `createProject({name})`                       | Caller becomes owner; id is server-assigned (ULID)                                                                    |
| `deleteProject(id)`                           | Owner-only; purges all project data                                                                                   |
| `listProjectMembers(id)`                      | Members of a project                                                                                                  |
| `addProjectMember(id, {username, role?})`     | Owner-only; `username` must be the invitee's **exact email address** (the server resolves via `findUserByExactEmail`) |
| `removeProjectMember(id, userId)`             | Owner removes anyone; non-owner self-leave only                                                                       |
| `removeProjectMemberByUsername(id, username)` | Convenience — resolves the username via members listing                                                               |

### Active project

| Method                      | Description                                         |
| --------------------------- | --------------------------------------------------- |
| `getActiveProject()`        | Current pointer or `{ active: null }`               |
| `setActiveProject(project)` | Set active project (id or name); membership-checked |
| `clearActiveProject()`      | Drop the pointer                                    |

### Tokens

| Method                     | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `mintToken({label?})`      | Plaintext shown once                                               |
| `listTokens()`             | sha256 hashes + metadata                                           |
| `revokeMyToken(tokenHash)` | Hard-delete a bearer by sha256 hash (`DELETE /v1/me/tokens/:hash`) |

### Dashboard auth (browser-style flow)

For non-browser callers that prefer a username + password flow over minting a `nm_…` bearer, the client also exposes `login({ email, password })` / `logout()` / `me()` — these talk to Better Auth's `/api/auth/*` and store the resulting session bearer on the client. Most non-browser callers should use a `nm_…` token directly instead.

## Notes

- The client uses native `fetch` (Node ≥ 20 or any modern browser).
- `setToken(t)` lets you swap the bearer in place (e.g. after a token rotation).
- Pass `fetch` in the constructor for testing or to use a different fetch impl.
- Errors throw with `Error("novamem <status>: <body>")` — handle as you would any fetch error.

See the main repo for the full API + dashboard documentation.

### Sensitivity levels

Write calls accept `sensitivity: "public" | "internal" | "private" | "sensitive"`; recall calls accept `maxSensitivity`. Recall defaults to `private`, excluding `sensitive` entries unless explicitly requested.

### Client adoption / refresh diagnostics

Use `client.adoption({ client: "hermes", observedTools })` to compare a caller's observed MCP tool list against the server's current manifest. The response includes `mcp.toolCount`, `mcp.tools`, `mcp.instructionsHash`, feature flags, diagnostics, and client-specific refresh commands.
