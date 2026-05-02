# novamem architecture

A 10-minute tour for new contributors. Updated to reflect the dashboard + projects work; for the original admin-dashboard arc see `openspec/changes/add-admin-dashboard/` (frozen change record).

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

## Isolation model

Two stacked rules:

1. **Tenant** is the legacy isolation unit. Every entry has a `tenant_id`. Tenant-wide entries (`project_id IS NULL`) are scoped by `tenant_id` on every query.
2. **Project** is the sub-brain isolation unit. When `project_id` is set, **project IS the access boundary** — tenant_id is decorative because projects can have members from different tenants.

The contract is enforced in three places:

- **Warm store** — `getEntry`, `ftsSearch`, `engine.recent`, `engine.forget`. Project-scoped queries filter on `project_id` ALONE; tenant-scoped queries filter on `tenant_id` AND `project_id IS NULL`.
- **Cold store** — separate qdrant collections per scope:
  - Tenant-wide: `novamem_<tenant>_<namespace>`
  - Project: `novamem_p_<project>_<namespace>`
  - The tenant-id regex forbids `p` and `p_*` so the prefixes can't collide.
- **Graph store** — every `Memory` node carries `tenant` + `project` properties. `addEdge`/`neighbors`/`removeAll*` filter on the appropriate one.

## AuthN / AuthZ

- **Tenant tokens (`nm_…`)** — minted via the dashboard or admin API. Stored as sha256 hashes only. Bound to one tenant + optionally one project at mint time. Used for the data plane.
- **Session bearers (`ns_…`)** — minted by `POST /v1/auth/login` against username + bcrypt password. Stored as sha256 hashes in `sessions`. 24-hour TTL fixed at creation; daily GC sweep deletes expired rows.
- **Roles** — `admin` (full surface, no tenant binding) or `user` (scoped to one tenant). Project membership crosses tenants.
- **Login throttle** — per-username, in-memory: 5 failures → 15-minute lockout with progressive 250ms→4s backoff.

The auth hook in `http.ts` resolves bearers in order: session prefix `ns_` → control plane; tenant prefix `nm_` → data plane; legacy admin token → `/v1/admin/*` only.

## Storage layout

### Postgres (warm)

| Table | Rows |
|---|---|
| `tenants` | tenant identity |
| `tenant_tokens` | sha256 hashes of bearer tokens |
| `users` | dashboard logins (bcrypt) |
| `sessions` | dashboard session bearers |
| `projects` | sub-brain identity |
| `project_members` | (project, user, role) — cross-tenant allowed |
| `memory_entries` | content + tenant + optional project |
| `memory_access` | hits + lastAccessed (per entry) |
| `memory_fts` | tsvector shadow table |
| `memory_relations` | edge audit log (graph store is authoritative) |
| `cold_orphans` | failed cold-deletes; reaper retries |
| `decay_runs` | per-loop summary |
| `admin_audit_log` | every tenant/user/role/token change |

DDL is **idempotent CREATE / ALTER IF NOT EXISTS**; runs on every server boot. Schema is forward-only — no migration tooling, no DROP COLUMN; back up before upgrading.

### Qdrant (cold)

One collection per (scope, namespace) pair. Collection names embed the scope id, so cross-scope queries are structurally impossible.

### FalkorDB (graph)

Single graph (`novamem`) with `Memory` nodes + `RELATES` edges. Node properties: `id`, `tenant`, `project`. The graph store is optional — when unreachable, search degrades to keyword + vector and reports `degraded: true`.

## Transports

- **HTTP/JSON** — Fastify 5. Bodies validated with Zod. OpenAPI 3.0 doc hand-written + served via `@fastify/swagger-ui` at `/api-docs`.
- **MCP stdio** — `packages/server/src/mcp.ts` (in-process) + `packages/mcp/src/index.ts` (remote shim that wraps the HTTP API).
- **MCP SSE** — `GET /mcp/sse` opens an event stream; `POST /mcp/messages?sessionId=…` sends JSON-RPC. Tenant + project + user are captured at handshake.

## Dashboard

`packages/admin-ui` — React 18 + Vite + Tailwind. Built and copied into `packages/server/dist/admin/ui/` by the server build; served by `@fastify/static` under `/admin/`. CSP is strict (`default-src 'self'`); Inter is bundled (no CDN).

Sign-in is username + password → session bearer. Bearer goes into `sessionStorage` for the tab's lifetime. `/v1/auth/logout` revokes server-side.

## Build + deploy

- pnpm workspaces. `pnpm -r build` builds in dependency order (client → mcp → admin-ui → server).
- The runtime Dockerfile drops privileges, ships only `dist/` + production deps, and declares `HEALTHCHECK`.
- Default port 7778 on both host + container.

## Things that aren't here yet

- No drizzle-kit migrations folder; schema lives in idempotent DDL strings.
- No Prometheus / OpenTelemetry exporter (`/v1/admin/metrics` is JSON, not exposition format).
- No K8s manifests / Helm chart. The bundled `docker-compose.yaml` is the only IaC.
- No HttpOnly-cookie session option; sessions live in `sessionStorage` (XSS-recoverable).
- TanStack Query / React Query not integrated; each dashboard page hand-rolls its polling.
- Test fakes are SQL-substring shims — solid for engine logic but not for verifying SQL correctness; PGlite migration is a candidate.

See [CHANGELOG.md](CHANGELOG.md) for behaviour shifts and [SECURITY.md](SECURITY.md) for the production hardening checklist.
