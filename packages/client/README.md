# @azrty/novamem

TypeScript client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service with hybrid search, multi-tenant isolation, and project (sub-brain) scoping.

```bash
npm install @azrty/novamem
```

## Quickstart

```ts
import { NovamemClient } from "@azrty/novamem";

const memory = new NovamemClient({
  baseUrl: "http://localhost:7778",
  token: process.env.NOVAMEM_TOKEN, // tenant `nm_…` or session `ns_…`
});

await memory.remember({ content: "User prefers dark roast" });
const hits = await memory.search({ query: "coffee preference", k: 5 });
```

## Project-scoped operations

Each entry can belong to a **project** (sub-brain). Pass `project` on writes to scope:

```ts
await memory.remember({ content: "phoenix sprint plan", project: "phoenix" });
await memory.search({ query: "sprint", project: "phoenix" });
```

When the supplied bearer is project-scoped (minted with `projectId`), `project` can be omitted — the server uses the token's bound project as the default.

## Auth (session-bearer flow)

For dashboard-equivalent operations (project CRUD, token mint), exchange username + password for a session token:

```ts
const memory = new NovamemClient({ baseUrl: "http://localhost:7778" });
await memory.login({ username: "bob", password: process.env.NOVAMEM_PASSWORD! });

await memory.createProject({ id: "phoenix", name: "Phoenix" });
const tok = await memory.mintToken({ label: "laptop", projectId: "phoenix" });
console.log(tok.token); // → nm_…  (shown once)

await memory.logout();
```

## API surface

### Memory data plane

| Method | Description |
|---|---|
| `search(req)` | Hybrid keyword + vector + graph search |
| `remember(req)` | Store a new entry |
| `recent(opts)` | Newest entries by namespace |
| `today(opts)` | Last-24h entries (sugar over `recent`) |
| `neighbors(opts)` | Graph-neighbour traversal from a seed id |
| `forget(id, opts?)` | Hard delete |
| `stats()` | Per-namespace counts |
| `health()` | Liveness + dependency status |
| `decay(opts?)` | Run the warm→cold demotion pass on demand |

All write operations and queries that take a `project` field use it for scoping; omit it for tenant-wide entries.

### Auth control plane (session bearer required)

| Method | Description |
|---|---|
| `login({username, password})` | Sign in; sets the bearer on the client |
| `logout()` | Server-side revoke + clear local bearer |
| `me()` | Current user info |

### Projects (session bearer required)

| Method | Description |
|---|---|
| `listProjects()` | Projects the user is a member of |
| `createProject({id, name})` | Caller becomes owner |
| `deleteProject(id)` | Owner-only; purges all project data |
| `listProjectMembers(id)` | Members of a project |
| `addProjectMember(id, {username, role?})` | Owner-only; cross-tenant allowed |
| `removeProjectMember(id, userId)` | Owner removes anyone; non-owner self-leave only |

### Tokens (session bearer required)

| Method | Description |
|---|---|
| `mintToken({label?, projectId?})` | Plaintext shown once |
| `listTokens()` | sha256 hashes + metadata |
| `revokeMyToken(tokenHash)` | Revoke by hash |

## Notes

- The client uses native `fetch` (Node ≥ 20 or any modern browser).
- `setToken(t)` lets you swap the bearer in place (e.g. after a token rotation).
- Pass `fetch` in the constructor for testing or to use a different fetch impl.
- Errors throw with `Error("novamem <status>: <body>")` — handle as you would any fetch error.

See the main repo for the full API + dashboard documentation.
