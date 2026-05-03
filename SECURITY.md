# Security

novamem is a tiered memory service handling user- and project-scoped data. This document covers the security model, hardening checklist for production deployments, and how to report vulnerabilities.

## Reporting a vulnerability

Email the maintainers privately rather than opening a public issue. We aim to acknowledge within 48 hours and ship a fix within 14 days for high-severity findings.

## Security model

### Identity and authentication

- **User bearers (`nm_…`)** — bearer tokens for the data plane (`/v1/search`, `/v1/remember`, etc.). Each bearer belongs to one user — typically representing a device or agent that user has authorised. The server stores only sha256 hashes; the plaintext is shown once at create time and is unrecoverable.
- **Session tokens (`ns_…`)** — bearer tokens for the dashboard control plane (`/v1/auth/*`, `/v1/me/*`, `/v1/admin/*`). 24-hour TTL fixed at creation; an in-process daily sweep deletes expired rows. The browser holds the session as an **HttpOnly + SameSite=Strict cookie**; the SPA additionally echoes a JS-readable `novamem_csrf` cookie back as `X-CSRF-Token` on POST/DELETE (double-submit CSRF).
- **Login** — username + bcrypt password. Per-username throttle: 5 failures → 15-minute lockout, with progressive 250ms→4s backoff before that.
- **First-login password change** — bootstrap admin and admin-created users land on a forced change-password screen (`password_changed_at IS NULL`).

### Authorization

- **User** is the global isolation unit. Every memory entry has a `user_id`; user-wide entries (`project_id IS NULL`) are scoped by `user_id` on every query.
- **Project** is the sub-brain isolation unit for shared memory. When an entry has `project_id`, **project IS the access boundary** — the SQL filters on `project_id` alone, because cross-user project members must be able to read/write shared data.
- A user bearer gives access to **everything its owning user can reach** — the user's whole memory namespace plus every project the user is a member of. Bearers are not scoped to a project; access flows from the owning user.
- Admins manage other users + system metrics. Admin auth is per-user (no shared admin token).

### Data isolation invariants (do not break)

1. `getEntry(userId, id, {projectId})` returns the row **only** if (a) the row is project-scoped and `row.project_id === projectId`, or (b) the row is user-wide and `row.user_id === userId`. There is no third path.
2. Cold collections are named `novamem_<userId>_<namespace>` for user-wide entries and `novamem_p_<projectId>_<namespace>` for project entries. User ids cannot start with `p_` or be exactly `p` — the create-user Zod schema enforces this. **Never relax that regex without also changing the cold-store collection naming scheme.**
3. Removing a project member must also revoke their project-related access. `WarmStore.removeProjectMember` deletes the membership row in a single transaction.
4. Cookie-authed `/v1/me/{search,recent,neighbors,remember,forget}` enforce project membership via `requireProjectAccess`. The `forget` mirror additionally re-fetches the entry's real scope and re-checks membership before deleting (defence in depth against `project: null` laundering).
5. Audit-log every admin action (user CRUD, role changes, token revoke). Read it at `GET /v1/admin/audit-log`.

## Production hardening checklist

If you're running novamem with real data:

### Required

- [ ] Set `NOVAMEM_BOOTSTRAP_ADMIN_USERNAME` + `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` once on first deploy. The password is auto-scrubbed from `process.env` after seeding so it doesn't surface via `docker inspect`. Rotate the seeded admin's password from the dashboard immediately (the first-login flow forces this).
- [ ] Set `NOVAMEM_COOKIE_SECRET` to a strong random value (`openssl rand -hex 32`). The dev fallback string MUST NOT be used in production.
- [ ] Set `NOVAMEM_AUTH_MODE=user` (the default).
- [ ] Set `NOVAMEM_INSECURE_COOKIES=0` (the default in non-dev images). Cookies are then `Secure` and require HTTPS.
- [ ] Restrict CORS via `NOVAMEM_CORS_ORIGINS` (comma-separated allowlist; default is same-origin only). `*` re-enables the legacy permissive behaviour — don't use it in production.
- [ ] Run the server behind a TLS-terminating reverse proxy or LoadBalancer with a real cert. `Authorization: Bearer …` and the session cookie over plain HTTP are plaintext.
- [ ] Do **not** expose Postgres / Qdrant / FalkorDB on host ports in production. The bundled `docker-compose.yaml` does this for local dev convenience; remove the `ports:` blocks for those services in production compose files.
- [ ] Change the Postgres password (the bundled `docker-compose.yaml` uses `novamem` as the default — fine for dev, dangerous in prod).
- [ ] Configure log shipping. Pino emits JSON to stdout; `Authorization`, `password`, and created token values are redacted via `redact:` config.

### Recommended

- [ ] Set `NOVAMEM_PG_POOL_MAX` to fit your Postgres `max_connections`. Default `20`.
- [ ] Run a Prometheus / OpenTelemetry sidecar that scrapes `/v1/admin/metrics`. The dashboard's polling-based metrics are operational, not historical.
- [ ] Configure Dependabot / Renovate. The lockfile is committed; major-version bumps need integration testing.
- [ ] Enable container scanning (Trivy / Grype) in your image pipeline.
- [ ] Use the `novamem-login` helper to mint device bearers for CLI / agents — never copy session cookies out of the browser.

### Operational gotchas

- **Schema is forward-only.** All DDL is `ALTER ... ADD COLUMN IF NOT EXISTS`. There is no rollback story beyond restoring from backup.
- **Sessions are server-side**: `/v1/auth/logout` deletes the row in `sessions`. Closing a tab without logging out leaves the session valid until TTL.
- **`/v1/admin/metrics` resets on restart** by design. It is not an SLO store.
- **Deleting a user is destructive.** `DELETE /v1/admin/users/:id` purges warm rows + cold collections + graph nodes + every token + every session belonging to that user. There is no soft delete.
- **Removed project members keep nothing.** Their membership row is deleted; their tokens stay valid against their own user namespace but they no longer see the project's memory.

## Threat model summary

| Adversary | What they can / cannot do |
|---|---|
| Anonymous internet user | Hit `/health`, `/api-docs`, `/openapi.json`, `/admin` HTML shell. Cannot read or write any memory. |
| Holder of a user bearer (`nm_…`) | Read/write everything the owning user can reach — user-global entries plus every project that user is a member of. Cannot mint other bearers, cannot reach `/v1/admin/*`. Can rotate the bearer via `/v1/auth/rotate-token`. |
| Logged-in user (role `user`) | Manage their own bearers + projects, view their own metrics. Can share a project with another user (adds them as a member). Cannot reach `/v1/admin/*`. |
| Logged-in user (role `admin`) | Manage all users, view system metrics, run decay. Admins do **not** automatically inherit other users' memory access — they manage identity, not data. |
| Compromised database | Sees password hashes (bcrypt, cost 10), token hashes (sha256). Plaintext bearers and passwords are not stored. Re-issued tokens can be invalidated by revoking the relevant rows. |
