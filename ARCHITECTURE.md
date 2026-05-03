# novamem architecture

A 10-minute tour for new contributors.

## System shape

```
┌─────────────────────────────────────────────────────┐
│                   Clients                           │
│  Browser dashboard │ MCP host │ HTTP CLI │ SDK       │
└──────────┬───────────────┬──────────┬──────┬────────┘
           │               │          │      │
           ▼               ▼          ▼      ▼
        ┌────────────────────────────────────────┐
        │          @azrty/novamem-server          │
        │       (Fastify, port 7778, HTTP+SSE)    │
        │                                         │
        │   /admin   /api-docs  /v1/auth/*        │
        │   /v1/me/* /v1/admin/* /v1/search etc.  │
        │                                         │
        │   ┌──────────────┐  ┌────────────────┐  │
        │   │ MemoryEngine │  │ AuthN (bcrypt) │  │
        │   └──────┬───────┘  │ AuthZ (RBAC)   │  │
        │          │          └────────────────┘  │
        │   ┌──────┴───────────────────────┐      │
        │   ▼          ▼            ▼     ▼      │
        │  Warm     Cold        Graph    Audit    │
        │  store   store        store    log      │
        └────┬─────────┬──────────┬────────┬──────┘
             │         │          │        │
        ┌────▼───┐ ┌───▼────┐ ┌───▼────┐  │
        │Postgres│ │ Qdrant │ │FalkorDB│  │
        │  warm  │ │  cold  │ │ graph  │  │
        └────────┘ └────────┘ └────────┘  │
                                          │
        Pino logs (stdout) ←──────────────┘
```

## Data tiering

A memory entry exists on the **warm** tier (Postgres, fully addressable, FTS-indexed) until the decay loop demotes it to the **cold** tier (Qdrant, vector-only). A search hits all three signals in parallel (warm FTS keyword, cold cosine vector, graph neighbours) and fuses with `min-max-normalised weighted scoring`.

- **Decay** — `effectiveDays(hits) = 7 × log₂(hits + 1)`. An entry idle for longer than its lifespan gets demoted. The decay loop runs every 6h by default; one bulk SQL UPDATE per loop tick.
- **Promotion** — reactive: a search that hits a cold entry whose accumulated lifespan now exceeds the pre-hit idle gap re-promotes it to warm.
- **Auto-linking** — every `remember()` finds the top-3 vector neighbours and writes `RELATES` edges to them in FalkorDB + a row in `memory_relations`. Populates the third search signal organically.

## Ownership model

A memory entry belongs to **exactly one user** (`memory_entries.user_id`). The user is the only first-class memory owner — there is no separate organization / tenant concept. A user can additionally create **projects** (sub-brains) which group memory and can be shared with other users.

Two stacked rules:

1. **User** is the global isolation unit. Every entry has a `user_id`; user-wide entries (`project_id IS NULL`) are scoped by `user_id` on every query.
2. **Project** is the sub-brain. When `project_id` is set, **project IS the access boundary** — `user_id` is decorative because projects can have members from different users (cross-user sharing).

Enforced in three places:

- **Warm store** — `getEntry`, `ftsSearch`, `engine.recent`, `engine.forget`. Project-scoped queries filter on `project_id` ALONE; user-scoped queries filter on `user_id` AND `project_id IS NULL`.
- **Cold store** — separate qdrant collections per scope:
  - User-wide: `novamem_<userId>_<namespace>`
  - Project: `novamem_p_<projectId>_<namespace>`
  - The user-id regex forbids `p` and `p_*` so the prefixes can't collide.
- **Graph store** — every `Memory` node carries `user` + `project` properties. `addEdge`/`neighbors`/`removeAllForUser` filter on the appropriate one.

## AuthN / AuthZ

- **User bearers (`nm_…`)** — minted via the dashboard `/v1/me/tokens`. One bearer per device or agent. Stored as sha256 hashes only; the plaintext is shown once at create time and is unrecoverable. A bearer gives access to **all** the owning user's memory — global plus every project the user is a member of (no per-token scope).
- **Session bearers (`ns_…`)** — minted by `POST /v1/auth/login` against username + bcrypt password. Stored as sha256 hashes in `sessions`. 24-hour TTL fixed at creation; daily GC sweep deletes expired rows. Used for the dashboard.
- **Roles** — `admin` (full surface; can manage other users) or `user` (manages their own memory + projects + tokens).
- **Login throttle** — per-username, in-memory: 5 failures → 15-minute lockout with progressive 250ms→4s backoff.
- **CSRF** — the dashboard uses an HttpOnly session cookie with double-submit CSRF token; the SPA echoes the JS-readable `novamem_csrf` cookie back as `X-CSRF-Token` on POST/DELETE.

The auth hook in `http.ts` resolves bearers in order: session prefix `ns_` → control plane (`/v1/auth/*`, `/v1/me/*`, `/v1/admin/*`); user-bearer prefix `nm_` → data plane (`/v1/search`, `/v1/remember`, etc.). Admin endpoints additionally require the resolved session to belong to a `role: admin` user.

## Storage layout

### Postgres (warm)

| Table | Rows |
|---|---|
| `users` | dashboard logins (bcrypt) — also the memory-owner identity |
| `user_tokens` | sha256 hashes of per-device bearers |
| `sessions` | dashboard session bearers |
| `projects` | sub-brain identity |
| `project_members` | (project, user, role) |
| `memory_entries` | content + user_id + optional project_id |
| `memory_access` | hits + lastAccessed (per entry) |
| `memory_fts` | tsvector shadow table |
| `memory_relations` | edge audit log (graph store is authoritative) |
| `cold_orphans` | failed cold-deletes; reaper retries |
| `decay_runs` | per-loop summary |
| `admin_audit_log` | every user/role/token change |

The synthetic id `"public"` exists as the implicit owner for `auth.mode=none|bearer` deployments — a pre-seeded row in `users`, never deleted.

DDL is **idempotent CREATE / ALTER IF NOT EXISTS**; runs on every server boot. Schema is forward-only — no migration tooling, no DROP COLUMN; back up before upgrading.

### Qdrant (cold)

One collection per (scope, namespace) pair. Collection names embed the scope id, so cross-scope queries are structurally impossible.

### FalkorDB (graph)

Single graph (`novamem`) with `Memory` nodes + `RELATES` edges. Node properties: `id`, `user`, `project`. The graph store is optional — when unreachable, search degrades to keyword + vector and reports `degraded: true`.

## Transports

- **HTTP/JSON** — Fastify 5. Bodies validated with Zod. OpenAPI 3.0 doc hand-written + served via `@fastify/swagger-ui` at `/api-docs`.
- **MCP stdio** — `packages/server/src/mcp.ts` (in-process) + `packages/mcp/src/index.ts` (remote shim that wraps the HTTP API).
- **MCP SSE** — `GET /mcp/sse` opens an event stream; `POST /mcp/messages?sessionId=…` sends JSON-RPC. User + project + dashboard-user id are captured at handshake.

## Dashboard

`packages/admin-ui` — React 19 + Vite + Tailwind 4. Built and copied into `packages/server/dist/admin/ui/` by the server build; served by `@fastify/static` under `/admin/`. CSP is strict (`default-src 'self'`); Inter + JetBrains Mono are bundled (no CDN).

Sign-in is username + password → HttpOnly session cookie + JS-readable CSRF cookie. `/v1/auth/logout` revokes server-side and clears both cookies.

Admin sidebar: Metrics · Health · Users.
User sidebar: Metrics · Browse · Graph · Today · Projects · API Tokens.

## Build + deploy

- pnpm workspaces. `pnpm -r build` builds in dependency order (client → mcp → admin-ui → server).
- The runtime Dockerfile drops privileges, ships only `dist/` + production deps, and declares `HEALTHCHECK`.
- Default port 7778 on both host + container.
- k3s manifests live under `deploy/k8s/` — single-replica StatefulSets for Postgres / Qdrant / FalkorDB on local-path PVCs, plus a `LoadBalancer` Service that binds 7778 on the node's host network.

## Things that aren't here yet

- No drizzle-kit migrations folder; schema lives in idempotent DDL strings.
- No Prometheus / OpenTelemetry exporter (`/v1/admin/metrics` is JSON, not exposition format).
- Test fakes are SQL-substring shims — solid for engine logic but not for verifying SQL correctness; PGlite migration is a candidate.

See [CHANGELOG.md](CHANGELOG.md) for behaviour shifts and [SECURITY.md](SECURITY.md) for the production hardening checklist.
