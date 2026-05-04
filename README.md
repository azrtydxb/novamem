# novamem

Standalone tiered memory service for AI agents.

- **Warm/Cold tiers** with synaptic decay (`effectiveDays = 7 × log₂(hits + 1)`)
- **Hybrid search**: keyword (Postgres FTS) + vector cosine (Qdrant) + graph neighbours (FalkorDB) — fused with min-max-normalized weighted scoring
- **Worthiness gate** at write time: hard-rule rejection of conversational filler + exact-duplicate fast-path
- **Dream cycle**: nightly dedup-merge by cosine similarity + edge promotion via common neighbours
- **Provenance fields** on every entry: `source_type`, `captured_from`, `confidence`
- **Per-user isolation** with **projects** (sub-brains): share a project with another user by adding them as a member
- **Two transports**: HTTP/JSON API and MCP (stdio shim + remote SSE)
- **Built-in dashboard** at `/admin`: email + password sign-in via Better Auth, admin + user roles
- **Storage**: Postgres (warm) · Qdrant (cold) · FalkorDB (graph, optional — degrades gracefully when unreachable)
- **Pluggable embeddings**: any OpenAI-compatible endpoint, or local via `@xenova/transformers` (default — no external API keys)

## Packages

- [`@azrty/novamem-server`](packages/server) — the standalone service (HTTP + MCP transports, Better Auth)
- [`@azrty/novamem`](packages/client) — TypeScript client + public types
- [`@azrty/novamem-mcp`](packages/mcp) — MCP-stdio shim binary for legacy clients that don't speak remote MCP yet
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
  token: process.env.NOVAMEM_TOKEN, // user bearer `nm_…`
});

// User-wide entry
await memory.remember({ content: "The user prefers dark roast.", namespace: "default" });

// Or scoped to a project (sub-brain) — id or human name both work
await memory.remember({ content: "Phoenix sprint plan", project: "Phoenix" });

// Search the same project
const hits = await memory.search({ query: "sprint plan", project: "Phoenix", k: 5 });
```

A user bearer (`nm_…`) carries every right the owning user has — the user's whole memory plus every project they're a member of. Pass `project: <id-or-name>` in any request body to scope to that project.

### Mount as an MCP tool — direct SSE (recommended)

Modern MCP-aware hosts (recent Claude Desktop, Claude Code, Cursor, …) speak remote MCP. Point them straight at the server:

```json
{
  "mcpServers": {
    "novamem": {
      "type": "sse",
      "url": "http://localhost:7778/mcp/sse",
      "headers": { "Authorization": "Bearer nm_…" }
    }
  }
}
```

No subprocess, no npm install. The token in `headers.Authorization` is your `nm_…` user bearer.

### Mount as an MCP tool — stdio shim (legacy)

For hosts that haven't shipped remote-MCP yet, the stdio shim bridges:

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azrty/novamem-mcp"],
      "env": {
        "NOVAMEM_BASE_URL": "http://localhost:7778",
        "NOVAMEM_TOKEN": "nm_…"
      }
    }
  }
}
```

### MCP tools advertised

Memory operations (every tool accepts an optional `project`; defaults to the caller's active project when set):

- `memory.search` — hybrid search; optional `weights`, `includeProjects`, `includeNamespaces`
- `memory.remember` — store an entry; accepts `sourceType`, `capturedFrom`, `confidence`, `force` (bypass worthiness gate)
- `memory.update` — rewrite an existing entry in place; preserves id, hits, edges; re-embeds when `content` changes
- `memory.recent` — newest entries; optional `since` ISO-8601
- `memory.today` — last-24h convenience wrapper around `memory.recent`
- `memory.neighbors` — graph traversal from a seed memory id
- `memory.forget` — explicit deletion (warm + FTS + cold + graph edges)
- `memory.stats` — per-namespace counts, last decay timestamp

Project lifecycle:

- `project.list` / `project.create` / `project.delete`
- `project.activate({ project })` / `project.deactivate` — set or clear the caller's active project. When set, `memory.*` calls without an explicit `project` arg default to it: read-side unions user-global with the active project, write-side targets the active project directly.
- `project.share({ project, username })` / `project.unshare(...)` — owner adds or removes members by email or display name.

## API surface

A live OpenAPI 3.0 reference is served at **`/api-docs`** (Swagger UI, with "Try it out" enabled) and the raw spec at **`/openapi.json`**. The dashboard sidebar links straight to it.

### Memory data plane

Every route accepts an optional `project` field (id or human name). When the caller has an active project set and `project` is omitted, search/recent/neighbors union user-global with the active project; remember/forget/update target the active project directly.

- `POST /v1/search` — hybrid search; optional `weights`, `includeProjects`, `includeNamespaces`
- `POST /v1/remember` — store an entry; provenance fields + `force` bypass for the worthiness gate
- `PUT /v1/memories/:id` — rewrite an entry in place; preserves id + hits + edges; re-embeds when `content` changes
- `POST /v1/recent` — newest entries; optional `since`
- `POST /v1/neighbors` — graph traversal from a seed memory id
- `POST /v1/forget` — explicit deletion
- `POST /v1/decay` — run the demotion pass on demand
- `POST /v1/dream-cycle` — manual trigger for the dedup-merge + edge-promotion pass (also runs daily on a timer)
- `GET /v1/stats` — per-namespace counts, last decay timestamp
- `GET /health` — liveness + dependency snapshot

### Dashboard control plane

Authenticated by the Better Auth session cookie (or by an `nm_…` bearer for non-browser callers — both flow through the same handler):

- `GET /v1/me/projects` / `POST /v1/me/projects` / `DELETE /v1/me/projects/:id`
- `GET /v1/me/projects/:id/members` / `POST /v1/me/projects/:id/members` / `DELETE /v1/me/projects/:id/members/:userId`
- `GET /v1/me/active-project` / `PUT /v1/me/active-project` / `DELETE /v1/me/active-project`
- `GET /v1/me/tokens` / `POST /v1/me/tokens` / `DELETE /v1/me/tokens/:hash`
- `GET /v1/me/metrics` — operational metrics scoped to this user (per-bearer breakdown)
- `GET /v1/me/metrics/history?hours=24` — persistent throughput history (1-min buckets, 24h window)
- `GET/POST/PUT/DELETE /v1/me/{search,remember,recent,neighbors,forget,memories/:id}` — same shape as `/v1/*`, gated by the dashboard session

### Auth

- `POST/GET /api/auth/*` — Better Auth surface (sign-up, sign-in/email, sign-out, get-session, change-password, JWT issuance at `/api/auth/token`, JWKS at `/api/auth/jwks`, admin user CRUD at `/api/auth/admin/*`).
- `POST /v1/auth/rotate-token` — rotate the caller's `nm_…` bearer atomically (CLI / device path).

### Admin

Gated by an admin session (Better Auth role = `admin`):

- `GET /v1/admin/audit-log` — every admin action recorded by the audit hook
- `GET /v1/admin/metrics` — global operational metrics snapshot
- `GET /v1/admin/metrics/prom` — Prometheus exposition format

User CRUD (create / list / promote / demote / remove) lives under Better Auth's `/api/auth/admin/*` — the dashboard SPA calls them directly.

## Authentication & isolation

Two coexisting credential types:

- **Better Auth sessions** (HttpOnly cookie or `Authorization: Bearer <session>` header) — the dashboard's email + password flow. Cookies are signed; sessions stored server-side; revocation by deleting the row.
- **`nm_…` user bearers** — minted via the dashboard's API Tokens page. One bearer per device or agent. Stored as sha256 hashes only; the plaintext is shown once at create time and is unrecoverable. Carries every right the owning user has.

Three operating modes via `NOVAMEM_AUTH_MODE`:

| mode | isolation | tokens | use for |
|---|---|---|---|
| `none` (default) | none — single shared `public` user | n/a | local dev only; logs a loud startup warning |
| `bearer` | none — single shared `public` user | one shared `NOVAMEM_AUTH_TOKEN` | single-team / single-app deployments |
| `user` | **per-user**, enforced server-side at every read & write | `nm_…` bearers and Better Auth sessions | multi-user deployments, agent fleets |

### Bootstrap a deployment

Set the bootstrap env vars and start the server:

```bash
export NOVAMEM_AUTH_MODE=user
export NOVAMEM_BOOTSTRAP_ADMIN_EMAIL="admin@example.com"
export NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -hex 16)"
export NOVAMEM_COOKIE_SECRET="$(openssl rand -hex 32)"
export NOVAMEM_BASE_URL="http://localhost:7778"
docker compose up -d
echo "dashboard at http://localhost:7778/admin — sign in as admin@example.com"
```

`NOVAMEM_BASE_URL` must match the URL the browser hits the API at — Better Auth uses it for trusted-origin / CSRF checks. The bootstrap admin is created on first start when no admin user exists yet.

From the **Users** tab the admin can create more users; each user signs in to the same dashboard, manages their own bearer tokens from the API Tokens page, and creates projects from the Projects page.

### Isolation guarantees

- **Warm store**: every row carries `user_id` and an optional `project_id`. User-wide queries filter by `user_id` (and `project_id IS NULL`). Project-scoped queries filter by `project_id` only — that's how cross-user project members can read shared entries.
- **Cold store**: user-wide entries live in `novamem_<userId>_<namespace>` collections; project entries live in `novamem_p_<projectId>_<namespace>`. There is no shared collection across either boundary.
- **Graph store**: every Memory node carries `user` + `project` properties; `addEdge` refuses mixed-scope pairs, `neighbors` filters on both.
- **Auto-linking on `remember()`**: vector neighbours are picked from the same `(user, project)` slot — two users can store identical content and never get linked.
- **MCP**: stdio shim takes one bearer per process. Direct-SSE captures the user at session handshake; subsequent JSON-RPC calls inherit it.

### Dashboard auth

Email + password sign-in, owned by Better Auth. Two roles:

- **admin** — manages users; sees system-wide Metrics / Health / Users tabs. Admins do not automatically inherit other users' memory access.
- **user** — sees Metrics (their slice), Browse, Graph, Today, Projects, API Tokens. Cannot reach `/v1/admin/*`.

Sessions are HttpOnly + SameSite=Lax cookies. CSRF is handled by Better Auth via trusted-origin checks on `NOVAMEM_BASE_URL`.

A device that already holds a `nm_…` bearer can self-rotate without going through the dashboard:

- `POST /v1/auth/rotate-token` — authed by the current bearer; returns a new plaintext (shown once) and atomically revokes the old.

`/health` and `/openapi.json` are always public so liveness probes still work.

## Projects (sub-brains)

A **project** is a memory scope owned by one user and optionally shared with others. Each entry can belong to at most one project; without a project, entries are user-wide.

A project gives a coherent body of work its own slot — when an agent searches with `project: phoenix` it sees only that project's entries; when it searches without a project it sees only user-wide entries.

**Sharing** is a first-class feature: add another user as a member (`POST /v1/me/projects/:id/members`) and their existing bearers immediately gain access to the shared project. The cold-store collection name and warm-store filter both key on the project id, so all members read the same data.

### Active project

Each user has an **active project** pointer. When set, memory.* calls without an explicit `project` arg default to it: search/recent/neighbors union user-global with the active project; remember/forget/update target the active project directly.

The dashboard sidebar offers a project switcher; agents can call `project.activate` / `project.deactivate` over MCP. The pointer is server-side state per user (table `user_active_project`), so a switch on one device is visible to every other device the user signs in from.

### Memory operations with `project`

Every read/write request body accepts an optional `project: string` field (id or human name):

- Omit `project` → operate on whatever's active, falling back to user-wide memory.
- `project: <id-or-name>` → operate on that project's memory. Must be a project the calling user can access (own or member); otherwise `403`.

```bash
# User-wide remember
curl -X POST http://localhost:7778/v1/remember \
  -H "authorization: Bearer $USER_BEARER" \
  -H "content-type: application/json" \
  -d '{"content":"a fact for me"}'

# Project-scoped remember (id or human name)
curl -X POST http://localhost:7778/v1/remember \
  -H "authorization: Bearer $USER_BEARER" \
  -H "content-type: application/json" \
  -d '{"content":"phoenix-only note","project":"Phoenix"}'
```

## Worthiness gate + dedup

Every `remember` call passes through a hard-rule worthiness gate before insertion:

- **Length floor**: trim then reject if < 12 chars
- **Filler regex**: rejects single-word canned replies (`thanks?`, `ok(ay)?`, `sure`, `got it`, `great`, `cool`, `yes`, `no`, `nope`, `yep`, `alright`, `noted`, `done`)
- **Exact-duplicate fast-path**: every entry stores a sha256 of its trimmed content; remember of identical content within the same `(user, project)` returns the existing id with `deduplicated: true` and bumps hits — no new row, no embed call

Pass `force: true` on the request body to bypass the worthiness rules. The exact-duplicate path always runs (even with `force`); duplicates of yourself just return the existing id.

A rejected request returns `200` with `{ id: null, rejected: <reason> }` rather than an HTTP error — the agent can read the reason and decide whether to retry with `force`.

## Dream cycle

Periodic compaction runs daily (and on demand via `POST /v1/dream-cycle`). Two phases:

1. **Dedup-merge**: for each entry, query qdrant for top-3 vector neighbours; merge a pair when cosine ≥ 0.97 AND token-set Jaccard ≥ 0.5 (both required so contradictions like "lives in X" / "lives in Y" don't collapse). Picks canonical by hit count (oldest tiebreak), redirects graph edges, sums hits, deletes the loser's warm row + FTS shadow + cold vector + graph node.
2. **Edge promotion**: when two entries share ≥3 graph neighbours in common, add a direct A→B edge with `relation: "co_inferred"`. Tagged distinctly from `co_occurs` so search ranking can dial it back.

The response shape: `{ walked, merged, edgesPromoted, durationMs }`.

## Dashboard

A built-in dashboard is served at `/admin` (e.g. <http://localhost:7778/admin>). Sign in with email + password.

**As an admin** you see three tabs:

- **Metrics** — query/remember/forget rates, hits per tier, promotions, demotions, decay-loop activity, store-size gauges. Polled every 5s. Includes a 24h persistent history chart and a "Run decay now" button.
- **Health** — liveness + per-dependency status (Postgres, Qdrant, FalkorDB), polled every 5s.
- **Users** — create / delete / promote-demote dashboard users (email + password). Cannot delete or demote the last admin.

**As a user** you see six tabs:

- **Metrics** — your slice (no cross-user counters; no decay/promotion controls). Throughput chart breaks out per-bearer rates; 24h history persisted across reboots.
- **Browse** — hybrid search across your memory (and the active project, if you've switched to one) plus a Remember composer.
- **Graph** — neighbour visualisation seeded on a recent memory.
- **Today** — timeline of your recent activity.
- **Projects** — create sub-brains, add members, leave / delete.
- **API Tokens** — create per-device bearers (label-only, no scope picker — every bearer carries every right the user has). Plaintext shown once at create time; the table shows the hash thereafter. Delete is hard.

Set `NOVAMEM_ADMIN_DASHBOARD=0` (or `false` / `no` / `off`) to disable both `/admin/*` and `GET /v1/admin/metrics`.

## Deployment

- `docker-compose.yaml` — single-host all-in-one (Postgres + Qdrant + FalkorDB + novamem on 7778).
- `deploy/k8s/` — k3s manifests with single-replica StatefulSets on local-path PVCs and a `LoadBalancer` Service that binds 7778 directly on the node host network. `kubectl apply -k deploy/k8s/`.

For a production deployment see the hardening checklist in [SECURITY.md](SECURITY.md).

## Backup + restore

Three stores need backing up; postgres is the only authoritative source for warm + project + audit + auth data.

```bash
# Postgres — pg_dump on a hot DB
docker exec novamem-1-postgres-1 pg_dump -U novamem -d novamem -Fc > novamem-warm.dump

# Qdrant — snapshot endpoint per collection (or take a tarball of the volume)
curl -X POST http://localhost:6333/collections/novamem_<userId>_default/snapshots

# FalkorDB — RDB dump via redis-cli BGSAVE
docker exec novamem-1-falkordb-1 redis-cli BGSAVE
```

To restore, restore Postgres first (it owns the foreign keys), then re-create the corresponding Qdrant collection / FalkorDB nodes from the snapshots — or accept that cold + graph will rebuild themselves on the next decay loop / `remember()` cycle.

`/v1/admin/metrics` is in-process and resets on every restart; the 24h history chart pulls from `metrics_samples` in Postgres which IS persisted.

Schema migrations are forward-only (`ALTER ... ADD COLUMN IF NOT EXISTS`); back up Postgres before upgrading novamem in place. There is no rollback path beyond `pg_restore`.

## Operator gotchas

- **`NOVAMEM_BASE_URL` must match the browser's origin.** Better Auth's trusted-origin check rejects `Origin: http://192.168.10.248:7778` if `baseUrl` is `http://0.0.0.0:7778`. Set this env var explicitly in production.
- **Bootstrap admin password is auto-scrubbed** from `process.env` after first-run seeding. Set the env var, restart, log in with email + password.
- **Schema is forward-only.** All DDL is `ALTER ... ADD COLUMN IF NOT EXISTS`. Back up Postgres before upgrading novamem in place; there is no rollback.
- **`/v1/admin/metrics` resets on restart.** Use `/v1/me/metrics/history` (or scrape `/v1/admin/metrics/prom` into Prometheus) for history.

For the full hardening checklist see [SECURITY.md](SECURITY.md).

## Status

Pre-1.0. API may change between minor versions until 1.0.

## License

MIT
