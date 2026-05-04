# @azrty/novamem

TypeScript client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service with hybrid search, per-user isolation, and project (sub-brain) scoping.

```bash
npm install @azrty/novamem
```

## Quickstart

```ts
import { NovamemClient } from "@azrty/novamem";

const memory = new NovamemClient({
  baseUrl: "http://localhost:7778",
  token: process.env.NOVAMEM_TOKEN, // user bearer `nm_…`
});

await memory_remember({ content: "User prefers dark roast" });
const hits = await memory_search({ query: "coffee preference", k: 5 });
```

A `nm_…` bearer carries every right the owning user has — the user's whole memory plus every project they're a member of. Mint one from the dashboard's API Tokens page.

## Project-scoped operations

Each entry can belong to a **project** (sub-brain). Pass `project` (id or human name) to scope:

```ts
await memory_remember({ content: "phoenix sprint plan", project: "Phoenix" });
await memory_search({ query: "sprint", project: "Phoenix" });
```

When the user has an active project set (`setActiveProject`), memory_* calls without an explicit `project` arg default to it: search/recent/neighbors union user-global with the active project; remember/forget/update target the active project directly.

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

| Method | Description |
|---|---|
| `search(req)` | Hybrid keyword + vector + graph search |
| `remember(req)` | Store a new entry; subject to the worthiness gate (pass `force: true` to bypass) |
| `updateMemory(id, req)` | Rewrite an entry in place; preserves id + hits + edges |
| `recent(opts)` | Newest entries by namespace |
| `today(opts)` | Last-24h entries (sugar over `recent`) |
| `neighbors(opts)` | Graph-neighbour traversal from a seed id |
| `forget(id, opts?)` | Hard delete |
| `stats()` | Per-namespace counts |
| `health()` | Liveness + dependency status |
| `decay(opts?)` | Run the warm→cold demotion pass on demand |

### Projects

| Method | Description |
|---|---|
| `listProjects()` | Projects the user is a member of |
| `createProject({name})` | Caller becomes owner; id is server-assigned (ULID) |
| `deleteProject(id)` | Owner-only; purges all project data |
| `listProjectMembers(id)` | Members of a project |
| `addProjectMember(id, {username, role?})` | Owner-only; username may be email or display name |
| `removeProjectMember(id, userId)` | Owner removes anyone; non-owner self-leave only |
| `removeProjectMemberByUsername(id, username)` | Convenience — resolves the username via members listing |

### Active project

| Method | Description |
|---|---|
| `getActiveProject()` | Current pointer or `{ active: null }` |
| `setActiveProject(project)` | Set active project (id or name); membership-checked |
| `clearActiveProject()` | Drop the pointer |

### Tokens

| Method | Description |
|---|---|
| `mintToken({label?})` | Plaintext shown once |
| `listTokens()` | sha256 hashes + metadata |
| `revokeMyToken(tokenHash)` | Revoke by hash |

### Dashboard auth (browser-style flow)

For non-browser callers that prefer a username + password flow over minting a `nm_…` bearer, the client also exposes `login({ email, password })` / `logout()` / `me()` — these talk to Better Auth's `/api/auth/*` and store the resulting session bearer on the client. Most non-browser callers should use a `nm_…` token directly instead.

## Notes

- The client uses native `fetch` (Node ≥ 20 or any modern browser).
- `setToken(t)` lets you swap the bearer in place (e.g. after a token rotation).
- Pass `fetch` in the constructor for testing or to use a different fetch impl.
- Errors throw with `Error("novamem <status>: <body>")` — handle as you would any fetch error.

See the main repo for the full API + dashboard documentation.
