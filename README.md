# novamem

Standalone tiered memory service for AI agents.

- **Warm/Cold tiers** with synaptic decay (`effectiveDays = 7 × log₂(hits + 1)`)
- **Hybrid search**: keyword (Postgres FTS) + vector cosine (Qdrant) + graph neighbours (FalkorDB) — fused with min-max-normalized weighted scoring
- **Per-user isolation**: every memory entry belongs to exactly one user; no organization / tenant concept on top of that
- **Projects** as sub-brains: optional shared memory groups; share a project with another user by adding them as a member
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
  token: process.env.NOVAMEM_TOKEN, // user bearer `nm_…` or session `ns_…`
});

// User-wide entry
await memory.remember({ content: "The user prefers dark roast.", namespace: "default" });

// Or scoped to a project (sub-brain)
await memory.remember({ content: "Phoenix sprint plan", project: "phoenix" });

// Search the same project
const hits = await memory.search({ query: "sprint plan", project: "phoenix", k: 5 });
```

A user bearer (`nm_…`) gives access to everything its owning user can reach — the user's whole memory plus every project they're a member of. Pass `project: <id>` in any request body to scope to that project.

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

- **`memory.search` / `memory.remember` / `memory.recent` / `memory.today` / `memory.neighbors` / `memory.forget` / `memory.stats`** — every tool accepts an optional `project` argument. Omit it to operate on user-wide memory; supply a project id (must be one the user can access) to scope to that sub-brain.
- **`project.list` / `project.create`** — require a session bearer (`ns_…`). Use the `novamem-login` helper or the SDK's `client.login(...)` to mint one.

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

## Authentication & isolation

Three modes, picked via `NOVAMEM_AUTH_MODE`:

| mode | isolation | tokens | use for |
|---|---|---|---|
| `none` (default) | none — single shared `public` user | n/a | local dev only; logs a loud startup warning |
| `bearer` | none — single shared `public` user | one shared `NOVAMEM_AUTH_TOKEN` | single-team / single-app deployments |
| `user` | **per-user**, enforced server-side at every read & write | user bearers (`nm_…`) for the data plane; dashboard session bearers (`ns_…`) for the control plane | multi-user deployments, agent fleets, anywhere "memories don't mix" matters |

In `user` mode the server stores only **sha256 hashes** of bearer tokens — the plaintext is shown once at creation and never again.

### Bootstrap a deployment

The fastest path is to seed a dashboard admin and use the UI:

```bash
export NOVAMEM_AUTH_MODE=user
export NOVAMEM_BOOTSTRAP_ADMIN_USERNAME="admin"
export NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -hex 16)"
export NOVAMEM_COOKIE_SECRET="$(openssl rand -hex 32)"
docker compose up -d
echo "dashboard at http://localhost:7778/admin — sign in as admin"
```

The first-login flow forces a password change immediately. From the **Users** tab the admin can create more users; each user signs in to the same dashboard, manages their own bearer tokens, and creates projects from the user-side surface.

If you'd rather drive everything from curl:

```bash
# Login as admin (records HttpOnly session cookie + CSRF cookie)
curl -c cookies.txt -X POST http://localhost:7778/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"…"}'

# Create a user (admin session required)
CSRF=$(awk '$6=="novamem_csrf" {print $7}' cookies.txt)
curl -b cookies.txt -X POST http://localhost:7778/v1/admin/users \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"username":"alice","password":"…","role":"user"}'
```

That user then logs in, opens **API Tokens**, and creates a bearer to embed in their device's MCP config.

### Isolation guarantees

- **Warm store**: every row carries `user_id` and an optional `project_id`. User-wide queries filter by `user_id` (and `project_id IS NULL`). Project-scoped queries filter by `project_id` only — that's how cross-user project members can read shared entries.
- **Cold store**: user-wide entries live in `novamem_<userId>_<namespace>` collections; project entries live in `novamem_p_<projectId>_<namespace>`. There is no shared collection across either boundary.
- **Graph store**: every Memory node carries `user` + `project` properties; `addEdge` refuses mixed-scope pairs, `neighbors` filters on both.
- **Auto-linking on `remember()`**: vector neighbours are picked from the same `(user, project)` slot — two users can store identical content and never get linked.
- **MCP**: stdio shim takes one bearer per process. SSE-MCP captures the user + project at session handshake; subsequent JSON-RPC calls inherit it.

### Dashboard auth (admin + user logins)

The dashboard authenticates with **username + password**, not raw tokens. There are two roles:

- **admin** — full surface (Metrics · Health · Users); manages other users and views system metrics. Admins do not automatically inherit other users' memory access.
- **user** — sees Metrics (their slice), Browse, Graph, Today, Projects, API Tokens. Cannot reach `/v1/admin/*`.

Logins return a 24h-TTL session that the SPA holds in an HttpOnly + SameSite=Strict cookie, with a JS-readable `novamem_csrf` cookie that the SPA echoes back as `X-CSRF-Token` on POST/DELETE (double-submit CSRF).

### Admin routes

All gated by an admin session:

- `GET    /v1/admin/users` / `POST /v1/admin/users` / `DELETE /v1/admin/users/:id` — user CRUD (delete purges warm + cold + graph + tokens + sessions for that user). Cannot delete yourself or the last admin.
- `POST   /v1/admin/users/:id/role` — promote / demote (`{role: "admin" | "user"}`)
- `POST   /v1/admin/tokens/revoke` — revoke a user bearer by plaintext (CLI path)
- `GET    /v1/admin/audit-log` — every admin action
- `GET    /v1/admin/metrics` — operational metrics snapshot

### User self-service routes

Authenticated by the dashboard session cookie:

- `GET    /v1/auth/me` — current user info
- `POST   /v1/auth/logout` — revoke this session
- `POST   /v1/auth/change-password` — first-login flow + voluntary changes
- `GET    /v1/me/metrics` — operational metrics scoped to this user (and their tokens' per-bearer breakdown)
- `GET    /v1/me/tokens` / `POST /v1/me/tokens` / `DELETE /v1/me/tokens/:hash` — list / create / delete bearers. Create accepts `{label}`. Delete is hard — the row leaves the table.
- `GET    /v1/me/projects` / `POST /v1/me/projects` / `DELETE /v1/me/projects/:id` — own / share projects (see below)
- `GET    /v1/me/projects/:id/members` / `POST /v1/me/projects/:id/members` / `DELETE /v1/me/projects/:id/members/:userId` — project membership

A device that already holds a bearer can self-rotate without going through the dashboard:

- `POST /v1/auth/rotate-token` — authed by the current `nm_…` bearer; returns a new plaintext (shown once) and atomically revokes the old. `user` mode only.

`/health` and `/openapi.json` are always public so liveness probes still work.

## Projects (sub-brains)

A **project** is a memory scope owned by one user and optionally shared with others. Each entry can belong to at most one project; without a project, entries are user-wide.

A project gives a coherent body of work its own slot — when an agent searches with `project: phoenix` it sees only that project's entries; when it searches without a project it sees only user-wide entries.

**Sharing** is a first-class feature: add another user as a member (`POST /v1/me/projects/:id/members`) and their existing bearers immediately gain access to the shared project. The cold-store collection name and warm-store filter both key on the project id, so all members read the same data.

### From the dashboard

Sign in, open the **Projects** tab:

1. Create a project — pick a slug id and a display name. You become the owner.
2. Expand it and add a member by username. The new member's existing bearers + sessions can immediately access the project.
3. Use any of your bearer tokens — they all see the project automatically.

### From a CLI / skill / MCP host

The MCP shim (`@azrty/novamem-mcp`) exposes `project.list` and `project.create` tools alongside the memory tools. These require a **session bearer** (`ns_…`), not a user bearer. A small helper ships in the same package to exchange username + password for a session token:

```bash
# Login (writes the session token to stdout, log line to stderr)
SESSION=$(NOVAMEM_USERNAME=bob npx -p @azrty/novamem-mcp novamem-login)
# Use it as the MCP shim's bearer — every memory.* call is now scoped to
# the user, and project.create / project.list are available.
NOVAMEM_TOKEN=$SESSION npx @azrty/novamem-mcp
```

Or directly via the typed client:

```ts
import { NovamemClient } from "@azrty/novamem";

const memory = new NovamemClient({ baseUrl: "http://localhost:7778" });
await memory.login({ username: "bob", password: process.env.NOVAMEM_PASSWORD! });

await memory.createProject({ id: "phoenix", name: "Phoenix" });

// Mint a bearer for the device — gives access to everything bob can reach
const tok = await memory.mintToken({ label: "this-laptop" });
console.log(tok.token); // → nm_… — store this; only shown once
```

### Memory operations with `project`

Every read/write request body accepts an optional `project: string` field:

- Omit `project` → operate on the user's user-wide memory.
- `project: <id>` → operate on that project's memory. Must be a project the calling user can access (own or member); otherwise `403`.

```bash
# User-wide remember
curl -X POST http://localhost:7778/v1/remember \
  -H "authorization: Bearer $USER_BEARER" \
  -H "content-type: application/json" \
  -d '{"content":"a fact for me"}'

# Project-scoped remember
curl -X POST http://localhost:7778/v1/remember \
  -H "authorization: Bearer $USER_BEARER" \
  -H "content-type: application/json" \
  -d '{"content":"phoenix-only note","project":"phoenix"}'
```

## Dashboard

A built-in dashboard is served at `/admin` (e.g. <http://localhost:7778/admin>). Sign in with your username + password.

**As an admin** you see three tabs:

- **Metrics** — query/remember/forget rates, hits per tier (warm vs cold vs graph), promotions, demotions, decay-loop activity, and store-size gauges. Polled every 5s. Includes a "Run decay now" button.
- **Health** — liveness + per-dependency status (Postgres, Qdrant, FalkorDB), polled every 5s.
- **Users** — create / delete / promote-demote dashboard users. Cannot delete yourself or the last admin.

**As a user** you see six tabs:

- **Metrics** — your slice (no cross-user counters; no decay/promotion controls). The throughput chart breaks out per-bearer rates.
- **Browse** — hybrid search across your memory (and an active project, if you've switched to one) plus a Remember composer.
- **Graph** — neighbour visualisation seeded on a recent memory.
- **Today** — timeline of your recent activity (remembers, token mints, project joins, audit-log entries).
- **Projects** — create sub-brains, add members, leave / delete.
- **API Tokens** — create per-device bearers (label-only, no scope picker — every bearer inherits all the user's access). Plaintext shown once at create time; the table shows the hash thereafter. Delete is hard — the row leaves the table.

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

## Deployment

- `docker-compose.yaml` — single-host all-in-one (Postgres + Qdrant + FalkorDB + novamem on 7778).
- `deploy/k8s/` — k3s manifests with single-replica StatefulSets on local-path PVCs and a `LoadBalancer` Service that binds 7778 directly on the node host network. `kubectl apply -k deploy/k8s/`.

For a production deployment see the hardening checklist in [SECURITY.md](SECURITY.md).

## Backup + restore

Three stores need backing up; postgres is the only authoritative source for warm + project + audit data.

```bash
# Postgres — pg_dump on a hot DB
docker exec novamem-1-postgres-1 pg_dump -U novamem -d novamem -Fc > novamem-warm.dump

# Qdrant — snapshot endpoint per collection (or take a tarball of the volume)
curl -X POST http://localhost:6333/collections/novamem_<userId>_default/snapshots

# FalkorDB — RDB dump via redis-cli BGSAVE
docker exec novamem-1-falkordb-1 redis-cli BGSAVE
```

To restore, restore Postgres first (it owns the foreign keys), then re-create the corresponding Qdrant collection / FalkorDB nodes from the snapshots — or accept that cold + graph will rebuild themselves on the next decay loop / `remember()` cycle.

`/v1/admin/metrics` resets on every restart by design — there is nothing to back up there.

Schema migrations are forward-only (`ALTER ... ADD COLUMN IF NOT EXISTS`); back up Postgres before upgrading novamem in place. There is no rollback path beyond `pg_restore`.

## Operator gotchas

- **User ids cannot start with `p_` or be exactly `p`.** Such ids would collide with the project-scoped collection name prefix and let the bearer hit another user's project's vector data via collection-name guessing. Enforced by Zod at create time.
- **Removing a project member** drops their membership row atomically. Their bearers stay valid against their own user namespace but they no longer see the shared project.
- **Bootstrap admin password is auto-scrubbed** from `process.env` after first-run seeding. Set the env var, restart, log in, the first-login flow forces a password change. The username env var stays — it isn't sensitive.
- **Schema is forward-only.** All DDL is `ALTER ... ADD COLUMN IF NOT EXISTS`. Back up Postgres before upgrading novamem in place; there is no rollback.
- **`/v1/admin/metrics` resets on restart.** It is not an SLO store. Scrape it into your TSDB if you want history.

For the full hardening checklist see [SECURITY.md](SECURITY.md).

## Status

Pre-1.0. API may change between minor versions until 1.0.

## License

MIT
