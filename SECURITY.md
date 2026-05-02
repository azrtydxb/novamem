# Security

novamem is a tiered memory service handling tenant- and project-scoped data. This document covers the security model, hardening checklist for production deployments, and how to report vulnerabilities.

## Reporting a vulnerability

Email the maintainers privately rather than opening a public issue. We aim to acknowledge within 48 hours and ship a fix within 14 days for high-severity findings.

## Security model

### Identity and authentication

- **Tenant tokens (`nm_…`)** — bearer tokens for the data plane (`/v1/search`, `/v1/remember`, etc.). Server stores only sha256 hashes; the plaintext is shown once at mint and is unrecoverable.
- **Session tokens (`ns_…`)** — bearer tokens for the dashboard control plane (`/v1/auth/*`, `/v1/me/*`, `/v1/admin/*`). 24-hour TTL fixed at creation; an in-process daily sweep deletes expired rows.
- **Login** — username + bcrypt password. Per-username throttle: 5 failures → 15-minute lockout, with progressive 250ms→4s backoff before that.
- **Legacy admin token** — `NOVAMEM_ADMIN_TOKEN` env var unlocks `/v1/admin/*` for CI scripts. Constant-time compared.

### Authorization

- **Tenant** is the legacy isolation unit and remains the boundary for tenant-wide entries (`project_id IS NULL`).
- **Project** is the new isolation unit for shared sub-brains. When an entry has `project_id`, **project IS the access boundary** — the SQL filters on `project_id` alone, because cross-tenant project members must be able to read/write shared data. Tenant-membership of the bearer is irrelevant for project-scoped queries.
- A bearer token is bound to either tenant-wide scope or a single project at mint time. A project-scoped bearer + a `project` field in the request body that mismatches the bearer's binding → `403`. A tenant-wide bearer that asks for a project in the body → `403`.
- Admin role is global (no tenant binding); user role is bound to one tenant.

### Data isolation invariants (do not break)

1. `getEntry(tenantId, id, {projectId})` returns the row **only** if (a) the row is project-scoped and `row.project_id === projectId`, or (b) the row is tenant-wide and `row.tenant_id === tenantId`. There is no third path. Do not add a magic-string bypass.
2. Cold collections are named `novamem_<tenant>_<namespace>` for tenant-wide entries and `novamem_p_<project>_<namespace>` for project entries. Tenant ids cannot start with `p_` or be exactly `p` — the `AdminCreateTenantBody` Zod schema enforces this. **Never relax that regex without also changing the cold-store collection naming scheme.**
3. Removing a project member must also revoke that user's project-scoped tokens. `WarmStore.removeProjectMember` does this in a single transaction; `engine.deleteProject` does it as part of the cascade.
4. Audit-log every admin action (tenant CRUD, user CRUD, role changes, token revoke). Read it at `GET /v1/admin/audit-log`.

## Production hardening checklist

If you're running novamem with real data:

### Required

- [ ] Set a strong `NOVAMEM_ADMIN_TOKEN` (`openssl rand -hex 32`).
- [ ] Set `NOVAMEM_BOOTSTRAP_ADMIN_USERNAME` + `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` once on first deploy. The password is auto-scrubbed from `process.env` after seeding so it doesn't surface via `docker inspect`. Rotate the seeded admin's password from the dashboard immediately.
- [ ] Set `NOVAMEM_AUTH_MODE=tenant` (the default).
- [ ] Restrict CORS via `NOVAMEM_CORS_ORIGINS` (comma-separated allowlist; default is same-origin only). `*` re-enables the legacy permissive behaviour — don't use it in production.
- [ ] Run the server behind TLS-terminating reverse proxy (Nginx/Caddy/Cloudflare). `Authorization: Bearer …` over plain HTTP is plaintext.
- [ ] Do **not** expose Postgres / Qdrant / FalkorDB on host ports in production. The bundled `docker-compose.yaml` does this for local dev convenience; remove the `ports:` blocks for those services in production compose files.
- [ ] Change the Postgres password (the bundled `docker-compose.yaml` uses `novamem` as the default — fine for dev, dangerous in prod).
- [ ] Configure log shipping. Pino emits JSON to stdout; `Authorization`, `password`, and minted token values are redacted via `redact:` config.

### Recommended

- [ ] Set `NOVAMEM_PG_POOL_MAX` to fit your Postgres `max_connections`. Default `20`.
- [ ] Run a Prometheus or OpenTelemetry sidecar that scrapes `/v1/admin/metrics` (JSON). The dashboard's polling-based metrics are operational, not historical.
- [ ] Configure Dependabot / Renovate. The lockfile is committed; major-version bumps need integration testing.
- [ ] Enable container scanning (Trivy / Grype) in your image pipeline.
- [ ] Use the `novamem-login` helper and minted project-scoped tokens for CI/skills, not the dashboard session cookie. Session bearers are stored in `sessionStorage` (not HttpOnly cookies); XSS in the dashboard would be able to lift them.

### Operational gotchas

- **Schema is forward-only.** All DDL is `ALTER ... ADD COLUMN IF NOT EXISTS`. There is no rollback story for schema migrations beyond restoring from backup.
- **Sessions are server-side**: logging out at `/v1/auth/logout` deletes the row in the `sessions` table. Closing a tab without logging out leaves the session valid until TTL.
- **`/v1/admin/metrics` resets on restart** by design. It is not an SLO store.
- **Project deletion is destructive across tenants.** The owner alone can trigger it. The dashboard requires a type-to-confirm step. There is no soft delete.
- **Removed members keep nothing.** Their project membership row is deleted AND their project-scoped tokens are revoked atomically.

## Threat model summary

| Adversary | What they can / cannot do |
|---|---|
| Anonymous internet user | Hit `/health`, `/api-docs`, `/openapi.json`, `/admin` HTML shell. Cannot read or write any memory. |
| Holder of a tenant-wide `nm_…` token | Read/write tenant-wide entries for that tenant only. Cannot see project entries. Cannot mint other tokens. Can rotate own token via `/v1/auth/rotate-token`. |
| Holder of a project-scoped `nm_…` token | Read/write only that project's entries. Cannot see tenant-wide entries. Cannot mint other tokens. |
| Logged-in user (role `user`) | Manage their own API tokens, manage projects they own, read project metrics. Cannot reach `/v1/admin/*`. |
| Logged-in user (role `admin`) | Manage tenants, users, dashboard configuration, view metrics. **Cannot bypass the project access rule** via the data plane — admin tokens only unlock `/v1/admin/*`. |
| Compromised database | sees password hashes (bcrypt, cost 10), token hashes (sha256). Plaintext bearers and passwords are not stored. Re-issued tokens can be invalidated by revoking the relevant rows. |
