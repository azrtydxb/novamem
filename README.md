# novamem

Standalone tiered memory service for AI agents.

- **Warm/Cold tiers** with synaptic decay (`effectiveDays = 7 × log₂(hits + 1)`)
- **Hybrid search**: keyword (Postgres FTS) + vector cosine (Qdrant) + graph neighbours (FalkorDB) — fused with min-max-normalized weighted scoring
- **Projects** as sub-brains: scope memory to a coherent body of work; share a project with another user (any tenant)
- **Two transports**: HTTP/JSON API and MCP (stdio + SSE)
- **Built-in dashboard** at `/admin`: username/password sign-in, admin + user roles, projects + per-device tokens
- **Storage**: Postgres (warm) · Qdrant (cold) · FalkorDB (graph, optional — degrades gracefully when unreachable)
- **Pluggable embeddings**: any OpenAI-compatible endpoint, or local via `@xenova/transformers` (default — no external API keys)

## Packages

- [`@azrty/novamem-server`](packages/server) — the standalone service (HTTP + MCP transports)
- [`@azrty/novamem`](packages/client) — TypeScript client + public types
- [`@azrty/novamem-mcp`](packages/mcp) — MCP-stdio shim binary + `novamem-login` helper
- [`@azrty/novamem-admin-ui`](packages/admin-ui) — React dashboard (built into the server image)

## Quickstart

```bash
docker compose up -d
curl http://localhost:7778/health
```

Default port: HTTP **7778** (host + container). Postgres on 5432, Qdrant on 6333, FalkorDB on 6379.

The compose stack boots Postgres, Qdrant, FalkorDB, and the memory server with local embeddings — no external API keys required.

### Use from any TypeScript agent

```ts
import { NovamemClient } from "@azrty/novamem";

const memory = new NovamemClient({
  baseUrl: "http://localhost:7778",
  token: process.env.NOVAMEM_TOKEN, // tenant `nm_…` or session `ns_…`
});

// Tenant-wide entry
await memory.remember({ content: "The user prefers dark roast.", namespace: "default" });

// Or scoped to a project (sub-brain)
await memory.remember({ content: "Phoenix sprint plan", project: "phoenix" });

// Search the same project
const hits = await memory.search({ query: "sprint plan", project: "phoenix", k: 5 });
```

When the supplied token is project-scoped (minted with a `projectId`), you can omit the `project` field — the server uses the token's bound project as the default.

### Mount as an MCP tool — stdio

For local MCP-aware hosts (Claude Desktop, Cursor, Cline, Claude Code):

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azrty/novamem-mcp"],
      "env": {
        "NOVAMEM_BASE_URL": "http://localhost:7778",
        "NOVAMEM_TOKEN": "nm_…   (or ns_… for project init)"
      }
    }
  }
}
```

Tools advertised by the shim:

- **`memory.search` / `memory.remember` / `memory.recent` / `memory.today` / `memory.neighbors` / `memory.forget` / `memory.stats`** — every tool accepts an optional `project` argument. With a project-scoped tenant token (`nm_…`), the project is bound automatically; with a tenant-wide token, omit `project` for tenant-wide entries (passing one is rejected).
- **`project.list` / `project.create`** — require a session bearer (`ns_…`). Use the `novamem-login` helper or the SDK's `client.login(...)` to mint one. Once you call `project.create`, you typically also `mintToken({ projectId })` so devices can stop using the session bearer and run with a long-lived `nm_…` scoped to that project.

### Mount as an MCP tool — SSE

For remote MCP hosts that prefer HTTP+SSE transport, the server itself exposes:

- `GET /mcp/sse` — opens the SSE event stream and returns a `sessionId`
- `POST /mcp/messages?sessionId=<id>` — sends JSON-RPC requests

Hosts that support SSE-MCP (e.g. some claude.ai integrations, custom agents) point at `http://<host>:7778/mcp/sse` directly — no shim needed.

## API surface

A live OpenAPI 3.0 reference is served at **`/api-docs`** (Swagger UI, with "Try it out" enabled) and the raw spec at **`/openapi.json`**. The dashboard sidebar links straight to it.

Memory data plane (also exposed as MCP tools `memory.<verb>`). Every route accepts an optional `project` field to scope to a sub-brain (see [Projects](#projects-sub-brains)):

- `POST /v1/search` — hybrid search; optional `weights` override per call, optional `project`
- `POST /v1/remember` — store an entry; optional `project`
- `POST /v1/recent` — newest entries in a namespace; optional `since` ISO-8601, optional `project`
- `POST /v1/neighbors` — graph traversal from a seed memory id; optional `project`
- `POST /v1/forget` — explicit deletion (warm + FTS + cold + graph edges); optional `project`
- `POST /v1/decay` — run the demotion pass on demand
- `GET /v1/stats` — per-namespace counts, last decay timestamp
- `GET /health` — liveness + dependency snapshot

## Authentication & multi-tenancy

Three modes, picked via `NOVAMEM_AUTH_MODE`:

| mode | isolation | tokens | use for |
|---|---|---|---|
| `none` (default) | none — single shared `public` tenant | n/a | local dev only; logs a loud startup warning |
| `bearer` | none — single shared `public` tenant | one shared `NOVAMEM_AUTH_TOKEN` | single-team / single-app deployments |
| `tenant` | **per-tenant**, enforced server-side at every read & write | one or more bearer tokens minted per tenant via admin API | multi-tenant SaaS, agent fleets, anywhere "memories don't mix" matters |

In `tenant` mode the server stores only **sha256 hashes** of bearer tokens — the plaintext is shown once at creation and never again.

### Bootstrap a tenant deployment

The fastest path is to seed a dashboard admin and use the UI:

```bash
export NOVAMEM_AUTH_MODE=tenant
export NOVAMEM_ADMIN_TOKEN="$(openssl rand -hex 32)"
export NOVAMEM_BOOTSTRAP_ADMIN_USERNAME="admin"
export NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -hex 16)"
docker compose up -d
echo "dashboard at http://localhost:7778/admin — sign in as admin"
```

If you'd rather drive everything from curl:

```bash
# Create a tenant (admin token required)
curl -X POST http://localhost:7778/v1/admin/tenants \
  -H "authorization: Bearer $NOVAMEM_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"id":"acme","name":"Acme Corp"}'

# Mint that tenant's first bearer token
curl -X POST http://localhost:7778/v1/admin/tenants/acme/tokens \
  -H "authorization: Bearer $NOVAMEM_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"laptop"}'
# → { token: "nm_…", warning: "Store this token now — it will not be shown again." }
```

The plaintext token in the response is what the tenant's client uses:

```bash
curl http://localhost:7778/v1/recent \
  -H "authorization: Bearer nm_…" \
  -H "content-type: application/json" -d '{}'
```

### Isolation guarantees

- **Warm store**: every row carries `tenant_id` and an optional `project_id`. Tenant-wide queries filter by `tenant_id` (and `project_id IS NULL`). Project-scoped queries filter by `project_id` only — that's how cross-tenant project members can read shared entries.
- **Cold store**: tenant-wide entries live in `novamem_<tenant>_<namespace>` collections; project entries live in `novamem_p_<project>_<namespace>`. There is no shared collection across either boundary.
- **Graph store**: every Memory node carries `tenant` + `project` properties; `addEdge` refuses mixed-scope pairs, `neighbors` filters on both.
- **Auto-linking on `remember()`**: vector neighbours are picked from the same `(tenant, project)` slot — two tenants can store identical content and never get linked.
- **MCP**: stdio shim takes a single token per process (one tenant or one project per shim). SSE-MCP captures the tenant + project at session handshake; subsequent JSON-RPC calls inherit it.

### Dashboard auth (admin + user logins)

The dashboard authenticates with **username + password**, not raw tokens. There are two roles:

- **admin** — full surface (Health · Metrics · Tenants · Users); manages tenants and users; not bound to a specific tenant.
- **user** — scoped to one tenant; sees Metrics (their tenant slice), creates Projects, manages their own API tokens; cannot reach admin routes.

Logins return a 24h-TTL session token (`ns_…`) that the SPA stores in `sessionStorage`. The legacy `NOVAMEM_ADMIN_TOKEN` is still accepted as a back-compat for `/v1/admin/*` callers (CI scripts), but the dashboard itself uses session auth.

#### Bootstrap an admin user

The first deploy seeds an admin from env vars (only when the users table is empty):

```bash
export NOVAMEM_AUTH_MODE=tenant
export NOVAMEM_ADMIN_TOKEN="$(openssl rand -hex 32)"
export NOVAMEM_BOOTSTRAP_ADMIN_USERNAME="admin"
export NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -hex 16)"
docker compose up -d
```

Open <http://localhost:7778/admin> and sign in. From the **Users** tab you can create more admins or per-tenant users; from **Tenants** you can create tenants for your users to belong to.

### Admin routes

All gated by an admin login OR the legacy `NOVAMEM_ADMIN_TOKEN`:

- `POST   /v1/admin/tenants` / `GET /v1/admin/tenants` — create / list tenants
- `DELETE /v1/admin/tenants/:id` — purge tenant (memories, vectors, graph, FTS, relations, orphans, tokens). Refuses `public`.
- `POST   /v1/admin/tenants/:id/tokens` / `GET /v1/admin/tenants/:id/tokens` — mint / list tenant tokens (plaintext shown once at mint; only sha256 hash stored)
- `POST   /v1/admin/tenants/:id/tokens/:hash/revoke` — revoke by hash (dashboard path)
- `POST   /v1/admin/tokens/revoke` — revoke by plaintext (CLI path)
- `GET    /v1/admin/users` / `POST /v1/admin/users` / `DELETE /v1/admin/users/:id` — user CRUD (refuses to delete yourself or the last admin)
- `POST   /v1/admin/users/:id/role` — promote / demote (`{role: "admin" | "user", tenantId?: string}`)
- `GET    /v1/admin/metrics` — operational metrics snapshot

### User self-service routes

Authenticated by a session bearer (`POST /v1/auth/login` → `ns_…`):

- `GET    /v1/auth/me` — current user info
- `POST   /v1/auth/logout` — revoke this session
- `GET    /v1/me/metrics` — operational metrics scoped to the user's tenant
- `GET    /v1/me/tokens` / `POST /v1/me/tokens` / `POST /v1/me/tokens/:hash/revoke` — list / mint / revoke API tokens for this user's tenant. Mint accepts `{label, projectId?}`.
- `GET    /v1/me/projects` / `POST /v1/me/projects` / `DELETE /v1/me/projects/:id` — own / share projects (see below)
- `GET    /v1/me/projects/:id/members` / `POST /v1/me/projects/:id/members` / `DELETE /v1/me/projects/:id/members/:userId` — project membership

A device that already holds a tenant token can self-rotate without going through the dashboard:

- `POST /v1/auth/rotate-token` — authed by the current `nm_…` bearer; returns a new plaintext (shown once) and atomically revokes the old. Tenant mode only.

`/health` and `/openapi.json` are always public so liveness probes still work.

## Projects (sub-brains)

A **project** is a memory scope inside a tenant. Each entry can belong to at most one project; without a project, entries are tenant-wide (the legacy behavior, preserved). Projects work like sub-brains: when you switch projects you see only that project's memory.

**Sharing across tenants** is a first-class feature: a project member can be a user from a different tenant. The cold-store collection name and warm-store filter both key on the project id (not the tenant), so cross-tenant members read the same data.

### From the dashboard

Sign in as a user (not an admin), open the **Projects** tab:

1. Create a project — pick a slug id and a display name. You become the owner.
2. Expand it and add a member by username. The new member sees the project on their next sign-in.
3. Open **API tokens**, choose **Scope: project: \<id\>** in the mint form, copy the plaintext.
4. Use that token from any device — its requests are scoped to the project automatically.

Tokens come in two flavors:

- **Tenant-wide** (`projectId: null`) — sees only tenant-wide entries.
- **Project-scoped** (`projectId: "phoenix"`) — sees only that project. Trying to write to a different project from this bearer returns `403`.

### From a CLI / skill / MCP host

The MCP shim (`@azrty/novamem-mcp`) exposes `project.list` and `project.create` tools alongside the memory tools. These require a **session bearer** (`ns_…`), not a tenant bearer. A small helper ships in the same package to exchange username + password for a session token:

```bash
# Login (writes the session token to stdout, log line to stderr)
SESSION=$(NOVAMEM_USERNAME=bob npx -p @azrty/novamem-mcp novamem-login)
# Use it as the MCP shim's bearer — every memory.* call is now scoped to
# the user, and project.create / project.list are available.
NOVAMEM_TOKEN=$SESSION npx @azrty/novamem-mcp
```

Or directly via curl + the typed client:

```ts
import { NovamemClient } from "@azrty/novamem";

const memory = new NovamemClient({ baseUrl: "http://localhost:7778" });
await memory.login({ username: "bob", password: process.env.NOVAMEM_PASSWORD! });

// Init a project from the skill side
await memory.createProject({ id: "phoenix", name: "Phoenix" });

// Mint a project-scoped token to embed in the device's MCP config
const tok = await memory.mintToken({ label: "this-laptop", projectId: "phoenix" });
console.log(tok.token); // → nm_… — store this; only shown once

// Now memory operations via that token are scoped to phoenix
await memory.remember({ content: "phoenix kickoff notes" }); // implicitly project=phoenix
```

### Memory operations with `project`

Every read/write request body accepts an optional `project: string` field. The server enforces:

- A project-scoped bearer + a different `project` in body → `403`.
- A tenant-wide bearer + a `project` in body → `403` (mint a project-scoped token instead).
- Otherwise the bearer's bound project (if any) is used as the default.

```bash
# Tenant-wide remember
curl -X POST http://localhost:7778/v1/remember \
  -H "authorization: Bearer $TENANT_TOKEN" \
  -H "content-type: application/json" \
  -d '{"content":"shared across the tenant"}'

# Project-scoped remember (token is bound to phoenix)
curl -X POST http://localhost:7778/v1/remember \
  -H "authorization: Bearer $PHOENIX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"content":"phoenix-only note"}'
```

## Dashboard

A built-in dashboard is served at `/admin` (e.g. <http://localhost:7778/admin>). Sign in with your username + password.

**As an admin** you see four tabs:

- **Health** — liveness + per-dependency status (Postgres, Qdrant, FalkorDB), polled every 5s.
- **Metrics** — query/remember/forget rates, hits per tier (warm vs cold vs graph), promotions, demotions, decay-loop activity, and store-size gauges. Polled every 5s. Includes a "Run decay now" button.
- **Tenants** — full CRUD: create tenants, mint admin tokens, revoke tokens by hash, delete tenants (type-to-confirm — purges all data).
- **Users** — create / delete / promote-demote dashboard users. Cannot delete yourself or the last admin.

**As a user** you see three tabs:

- **Metrics** — your tenant's slice (no cross-tenant counters; no decay/promotion controls).
- **Projects** — create sub-brains, add cross-tenant members, leave / delete.
- **API tokens** — mint per-device tokens with a **scope** selector (tenant-wide or any project you belong to). Plaintext shown once at mint; the table shows the hash + scope thereafter.

Set `NOVAMEM_ADMIN_DASHBOARD=0` (or `false` / `no` / `off`) to disable both `/admin/*` and `GET /v1/admin/metrics`.

`GET /v1/admin/metrics` returns a JSON document of the form:

```jsonc
{
  "counters": {
    "queries_total": 1234,
    "queries_zero_hit": 18,
    "remembers_total": 567,
    "forgets_total": 9,
    "promotions_total": 42,
    "demotions_total": 11,
    "decay_runs_total": 3,
    "orphans_reaped_total": 0,
    "hits_warm_total": 980,
    "hits_cold_total": 612,
    "hits_graph_total": 305
  },
  "gauges": {
    "warm_entries": 421,
    "cold_entries": 88,
    "graph_edges": 1330,        // null when FalkorDB is unreachable
    "orphans_pending": 0,
    "last_decay_run_iso": "2026-05-02T12:00:00.000Z"
  },
  "rates": {
    "queries_per_sec_60s": 2.4,
    "remembers_per_sec_60s": 0.1
  },
  "uptime_ms": 86400000
}
```

> **Note:** metrics live in-process and **reset on every restart**. This is an operational dashboard, not a long-term SLO store — for historical metrics, scrape `/v1/admin/metrics` into Prometheus / your TSDB of choice.

## Status

Pre-1.0. API may change between minor versions until 1.0.

## License

MIT
