# Changelog

All notable changes to novamem are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Better Auth for the dashboard.** Email + password sign-in via `POST /api/auth/sign-in/email`. Sessions stored in Better Auth's `"user"` / `"session"` / `"account"` / `"verification"` / `"jwks"` tables. JWT issuance on demand at `/api/auth/token` with JWKS at `/api/auth/jwks`. Admin user CRUD via Better Auth's `/api/auth/admin/*`.
- **`memory_update`** — rewrite an existing entry in place. Preserves id, hit count, graph edges, creation timestamp; refreshes FTS + cold vector when content changes; skips embedder for metadata-only updates. HTTP `PUT /v1/memories/:id` + cookie-auth mirror at `PUT /v1/me/memories/:id` + MCP tool.
- **Worthiness gate** at write time — `engine.shouldReject` rejects content < 12 chars or matching the conversational-filler regex; `force: true` bypasses. Returns `{id: null, rejected: <reason>}`.
- **Exact-duplicate fast-path** — `memory_entries.content_hash` (sha256 of trimmed content) lets `remember` short-circuit identical writes within the same `(user, project)` and return the existing id with `deduplicated: true`.
- **Dream cycle** — daily compaction + manual `POST /v1/dream-cycle`. Two phases: dedup-merge at cosine ≥ 0.97 + token Jaccard ≥ 0.5 (sums hit counts, redirects edges, deletes the duplicate); edge promotion when two entries share ≥3 graph neighbours (`relation: co_inferred`).
- **Provenance fields** on every entry — `source_type` (open vocab), `captured_from` (free text), `confidence` (0..1, default 1.0), `content_hash`. Plumbed through `RememberRequest`, `UpdateMemoryRequest`, the MCP tool inputs, and the search response.
- **Active project pointer** — `user_active_project` table holds a per-user "current sub-brain". When set, memory_* calls without an explicit `project` arg default to it. Exposed as `GET/PUT/DELETE /v1/me/active-project` and the `project_activate` / `project_deactivate` MCP tools.
- **Project lifecycle MCP tools** — `project_delete`, `project_share`, `project_unshare` round out the existing `project_list` / `project_create`.
- **`includeProjects[]` and `includeNamespaces[]`** on search/recent/neighbors — union user-global with the listed projects / cross-namespace recall, respectively. Both capped at 16 to bound fanout.
- **Project lookup by id OR human name** in every memory-* and project-* request body. Sharper 404 vs 403 errors: 404 "no such project" when the id/name resolves to nothing; 403 only when the project exists and the caller isn't a member.
- **24h persistent throughput chart** — `metrics_samples` table holds 1-minute buckets, written by a per-minute flush from the in-memory MetricsCollector. New `GET /v1/me/metrics/history?hours=24` powers a second chart on the user Metrics page.
- **Last-admin guard** — Better Auth passthrough refuses `remove-user` and `set-role(role=user)` against the only remaining admin (returns `400 LAST_ADMIN_PROTECTED`).
- **MCP `instructions` field** — server ships behaviour rules to compliant MCP clients on `initialize`. Single source of truth instead of per-agent `CLAUDE.md` fragments.
- **Direct SSE MCP** — recent clients point at `http://<host>:7778/mcp/sse` with `Authorization: Bearer nm_…` and skip the stdio shim. The shim stays in `@azrty/novamem-mcp` for legacy clients.
- **User-as-owner data model** — every memory entry belongs to one user. There is no separate "tenant" or "organization" concept. Admins manage users; users manage their own memory + projects + bearers.
- **Projects (sub-brains)** — memory entries can additionally belong to a project; projects can be shared with other users by adding them as members. Schema additions: `projects`, `project_members`, `project_id` columns on `memory_entries` / `memory_fts` / `memory_relations` / `cold_orphans`.
- **Embedded React dashboard** at `/admin` — admin (Users · Health · Metrics) and user (Browse · Graph · Today · Projects · API Tokens) surfaces.
- **Audit log** of admin actions (`/v1/admin/audit-log`) + Prometheus exposition at `/v1/admin/metrics/prom`.
- **Swagger UI** at `/api-docs` + structured `/openapi.json`.
- **Per-token metrics** — the user dashboard's throughput chart breaks out per-bearer rates alongside the user-aggregate totals.
- **k3s manifests** under `deploy/k8s/` — single-replica StatefulSets on local-path PVCs + `LoadBalancer` Service that binds 7778 directly on the node host network.

### Changed

- **Removed `username` field from the user model.** The dashboard's identity is now email + display name (Better Auth's defaults). The `users` and `sessions` tables are dropped from the DDL; FK constraints on `user_tokens` / `projects` / `project_members` were converted from `REFERENCES users(id)` to free-text references — Better Auth manages user lifecycle on its own table.
- **`/v1/admin/users` routes removed.** Better Auth's `/api/auth/admin/*` replaces them; the dashboard SPA's UsersPage calls those directly.
- **Login throttle removed.** Better Auth handles rate limiting via its own configuration.
- **CSRF double-submit removed.** Better Auth handles CSRF via trusted-origin checks against `NOVAMEM_BASE_URL`. Set this env var to the public origin in production.
- **`bcryptjs` dependency dropped** — Better Auth handles password hashing.
- **`/v1/auth/{login,logout,me,change-password,status}` removed.** Better Auth replaces them under `/api/auth/*`. `POST /v1/auth/rotate-token` stays for the CLI / device path on `nm_…` bearers.
- **`source_type` is an open string**, not an enum — recommended vocab (`chat / email / code-review / doc / inference / observation / system / manual`) is documented in the MCP `instructions` rather than enforced at the schema layer.
- **Bootstrap env vars.** `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` + `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` seed the first admin when no admin user exists. New required env in production: `NOVAMEM_BASE_URL`, `NOVAMEM_COOKIE_SECRET`.
- **Token semantics simplified.** A bearer no longer carries a project scope; it grants access to everything the owning user can reach. Token revoke is a hard `DELETE`.
- Default port is **7778** (host + container).
- `engine.decay()` rewritten as a single bulk `UPDATE` (was one round-trip per cold candidate; 500–1000× faster at scale).
- `engine.search()` batches the per-result `getEntry` + `bumpHits` lookups (was 2N+1 round-trips; now ~3).
- `engine.linkVectorNeighbors()` issues one `UNWIND` Cypher MERGE for the whole fanout.
- `cors: { origin: true }` replaced with an allowlist sourced from `NOVAMEM_CORS_ORIGINS` (defaults to same-origin only).
- Pino logger gains `redact` paths for Authorization headers, password fields, and created token plaintexts.
- Dockerfile runtime stage drops privileges (`USER node`), ships only built artefacts + production deps, and declares `HEALTHCHECK`.

### Removed

- `users` and `sessions` Postgres tables (replaced by Better Auth's `"user"` / `"session"`).
- `LoginThrottle`, CSRF cookie helpers, `hashPassword`/`verifyPassword`, `gcExpiredSessions` — the entire legacy `auth.ts` module.
- `novamem-login` CLI binary — use the dashboard to mint a `nm_…` bearer and pass it to MCP clients directly.
- `NOVAMEM_ADMIN_TOKEN`.
- `/v1/admin/tenants/*` routes (multi-tenant predecessor of `/v1/admin/users`).
- Per-bearer project scoping. Tokens have no `project_id` field; access flows from the owning user.

### Security

- **Project-membership guard on cookie-authed `/v1/me/*` mirrors** — refuses cross-project access; `/v1/me/forget` additionally re-fetches the entry's real scope before deleting (defence in depth against `project: null` laundering).
- **User id `p_*` is forbidden** at create time — would have collided with the project-scoped collection prefix `novamem_p_<project>_*`.
- **Removing a project member deletes the membership row** atomically.
- **`getEntry` magic-string `"*"` bypass removed** — there is no out-of-band way to disable user + project access checks.
- **`engine.forget` and `addRelation` use project_id as the access boundary** when the entry is project-scoped.
- **Bootstrap admin password is auto-scrubbed from `process.env`** after seeding.
- **Zod errors → 400** with structured `issues` (was bubbling up as 500).
- **Last admin protected.** Better Auth's `remove-user` / `set-role(role=user)` are intercepted server-side and refuse to leave zero admins.

### Notes

This is the first changelog entry; behaviour earlier than this is recorded only in git history. The /v1 API surface is stable but the schema migrations are forward-only — back up Postgres before upgrading novamem in place.
