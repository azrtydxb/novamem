# Changelog

All notable changes to novamem are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Projects (sub-brains)** — memory entries can belong to a project; projects can be shared with users from other tenants. Schema additions: `projects`, `project_members`, `project_id` columns on `memory_entries` / `memory_fts` / `memory_relations` / `cold_orphans` / `tenant_tokens`.
- **Dashboard sessions** — username + password login replaces token-paste. New `users` + `sessions` tables. bcrypt + per-username login throttle (5 fails → 15-minute lockout, progressive 250ms→4s backoff).
- **Embedded React dashboard** at `/admin` — admin and user roles, tenant CRUD, user CRUD, project sharing, scoped API tokens, scoped metrics.
- **Audit log** of admin actions (`/v1/admin/audit-log`).
- **Swagger UI** at `/api-docs` + structured `/openapi.json`.
- **MCP `project.list` / `project.create` tools** + `novamem-login` helper binary in `@azrty/novamem-mcp`.

### Changed

- Default port is now **7778** (host + container). Previous default was 5050 (host) → 5000 (container).
- Idempotent DDL ordering fixed: `ALTER TABLE memory_entries ADD COLUMN project_id` now runs **after** `CREATE TABLE memory_entries` (was crashing on a fresh DB).
- `engine.decay()` rewritten as a single bulk `UPDATE` (was one round-trip per cold candidate; 500–1000× faster at scale).
- `engine.search()` batches the per-result `getEntry` + `bumpHits` lookups (was 2N+1 round-trips; now ~3).
- `engine.linkVectorNeighbors()` issues one `UNWIND` Cypher MERGE for the whole fanout (was N round-trips).
- `cors: { origin: true }` replaced with an allowlist sourced from `NOVAMEM_CORS_ORIGINS` (defaults to same-origin only).
- Pino logger gains `redact` paths for Authorization headers, password fields, and minted token plaintexts.
- Dockerfile runtime stage now drops privileges (`USER node`), ships only built artefacts + production deps, and declares `HEALTHCHECK`.

### Security

- **Tenant id `p_*` is forbidden** at create time — would have collided with the project-scoped collection prefix `novamem_p_<project>_*` and let an admin wipe shared-project data via `deleteAllForTenant`.
- **Removing a project member now revokes that user's project-scoped tokens** atomically (previously the kicked user retained access).
- **`getEntry` magic-string `"*"` bypass removed** — there is no out-of-band way to disable both tenant + project access checks.
- **`engine.forget` and `addRelation` use project_id as the access boundary** when the entry is project-scoped (was filtering by tenant_id, which made cross-tenant project members' deletes silently no-op).
- **Per-username login throttle** + `verifyPassword` runs against a throwaway hash on unknown user (prevents user-enumeration via timing).
- **Bootstrap admin password is auto-scrubbed from `process.env`** after seeding.
- **Sessions GC sweep** — daily timer deletes expired session rows.
- **Zod errors → 400** with structured `issues` (was bubbling up as 500).

### Notes

This is the first changelog entry; behaviour earlier than this is recorded only in git history. The /v1 API surface is stable but the schema migrations are forward-only — back up Postgres before upgrading novamem in place.
