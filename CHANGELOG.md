# Changelog

All notable changes to novamem are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **User-as-owner data model** — every memory entry belongs to one user. There is no separate "tenant" or "organization" concept. Admins manage users; users manage their own memory + projects + bearers.
- **Projects (sub-brains)** — memory entries can additionally belong to a project; projects can be shared with other users by adding them as members. Schema additions: `projects`, `project_members`, `project_id` columns on `memory_entries` / `memory_fts` / `memory_relations` / `cold_orphans` / `user_tokens`.
- **Dashboard sessions** — username + password login replaces token-paste. New `users` + `sessions` tables. bcrypt + per-username login throttle (5 fails → 15-minute lockout, progressive 250ms→4s backoff). Sessions live in an HttpOnly + SameSite=Strict cookie with double-submit CSRF.
- **Embedded React dashboard** at `/admin` — admin (Users · Health · Metrics) and user (Browse · Graph · Today · Projects · API Tokens) surfaces. JetBrains Mono + Inter, oklch palette, light/dark theme toggle.
- **Audit log** of admin actions (`/v1/admin/audit-log`).
- **Swagger UI** at `/api-docs` + structured `/openapi.json`.
- **Per-token metrics** — the user dashboard's throughput chart breaks out per-bearer rates alongside the user-aggregate totals.
- **MCP `project.list` / `project.create` tools** + `novamem-login` helper binary in `@azrty/novamem-mcp`.
- **k3s manifests** under `deploy/k8s/` — single-replica StatefulSets on local-path PVCs + `LoadBalancer` Service that binds 7778 directly on the node host network.

### Changed

- **Tenants are gone.** The previous `tenants` table + per-tenant token + per-tenant admin routes are removed. `users.user_id` is the only owner key. `tenant_tokens` table renamed to `user_tokens`. `auth.mode` value `"tenant"` renamed to `"user"`.
- **Token semantics simplified.** A bearer no longer carries a project scope; it grants access to everything the owning user can reach (their global memory + every project they're a member of). The "Mint" terminology is renamed to "Create"; revoke is a hard `DELETE` so the row leaves the table immediately.
- **Admin sidebar trimmed** to Metrics · Health · Users (Tenants page removed).
- Default port is now **7778** (host + container). Previous default was 5050 (host) → 5000 (container).
- Idempotent DDL ordering fixed: `ALTER TABLE memory_entries ADD COLUMN project_id` now runs **after** `CREATE TABLE memory_entries` (was crashing on a fresh DB).
- `engine.decay()` rewritten as a single bulk `UPDATE` (was one round-trip per cold candidate; 500–1000× faster at scale).
- `engine.search()` batches the per-result `getEntry` + `bumpHits` lookups (was 2N+1 round-trips; now ~3).
- `engine.linkVectorNeighbors()` issues one `UNWIND` Cypher MERGE for the whole fanout (was N round-trips).
- `cors: { origin: true }` replaced with an allowlist sourced from `NOVAMEM_CORS_ORIGINS` (defaults to same-origin only).
- Pino logger gains `redact` paths for Authorization headers, password fields, and created token plaintexts.
- Dockerfile runtime stage now drops privileges (`USER node`), ships only built artefacts + production deps, and declares `HEALTHCHECK`.

### Removed

- **`NOVAMEM_ADMIN_TOKEN`** — the legacy back-compat path that let CI scripts hit `/v1/admin/*` with a shared bearer. Admin auth is now always per-user via session.
- **`/v1/admin/tenants/*`** routes (POST list / DELETE / mint / list / revoke per-tenant tokens). Admin manages users instead via `/v1/admin/users/*`.
- **Per-bearer project scoping.** Tokens have no `project_id` field on the create form; access flows from the owning user.

### Security

- **Project-membership guard on cookie-authed `/v1/me/*` mirrors** — `/v1/me/{search,recent,neighbors,remember,forget}` 403 when the caller targets a project they're not a member of. `/v1/me/forget` additionally re-fetches the entry's real scope before deleting (defence in depth).
- **User id `p_*` is forbidden** at create time — would have collided with the project-scoped collection prefix `novamem_p_<project>_*` and let an admin wipe shared-project data.
- **Removing a project member now deletes the membership row** atomically.
- **`getEntry` magic-string `"*"` bypass removed** — there is no out-of-band way to disable user + project access checks.
- **`engine.forget` and `addRelation` use project_id as the access boundary** when the entry is project-scoped (was filtering by user_id, which made cross-user project members' deletes silently no-op).
- **Per-username login throttle** + `verifyPassword` runs against a throwaway hash on unknown user (prevents user-enumeration via timing).
- **Bootstrap admin password is auto-scrubbed from `process.env`** after seeding.
- **First-login forced password change** for the bootstrap admin and any admin-created user.
- **Sessions GC sweep** — daily timer deletes expired session rows.
- **Zod errors → 400** with structured `issues` (was bubbling up as 500).

### Notes

This is the first changelog entry; behaviour earlier than this is recorded only in git history. The /v1 API surface is stable but the schema migrations are forward-only — back up Postgres before upgrading novamem in place.
