# Security

novamem is a tiered memory service handling user- and project-scoped data. This document covers the security model, hardening checklist for production deployments, and how to report vulnerabilities.

## Reporting a vulnerability

Email the maintainers privately rather than opening a public issue. We aim to acknowledge within 48 hours and ship a fix within 14 days for high-severity findings.

## Security model

### Identity and authentication

- **Better Auth sessions** — the dashboard control plane (`/api/auth/*`, `/v1/me/*`, `/v1/admin/*`). Email + password sign-in via `POST /api/auth/sign-in/email`. Sessions stored server-side in the `"session"` table; revocable by deleting the row. Browser holds the session as an **HttpOnly + SameSite=Lax cookie**; non-browser callers may also send the same value as `Authorization: Bearer <session>`. Better Auth handles password hashing (scrypt by default), session rotation, and CSRF via trusted-origin checks against `NOVAMEM_BASE_URL`. JWT issuance on demand at `/api/auth/token` (15-min TTL); JWKS at `/api/auth/jwks`.
- **`nm_…` user bearers** — bearer tokens for non-browser callers (MCP, CLI, scripts). Each bearer belongs to one user — typically representing a device or agent. The server stores only sha256 hashes in `user_tokens`; the plaintext is shown once at create time and is unrecoverable. A bearer carries every right the owning user has — it is not scoped to a project.

### Authorization

- **User** is the global isolation unit. Every memory entry has a `user_id`; user-wide entries (`project_id IS NULL`) are scoped by `user_id` on every query.
- **Project** is the sub-brain isolation unit for shared memory. When an entry has `project_id`, **project IS the access boundary** — the SQL filters on `project_id` alone, because cross-user project members must be able to read/write shared data.
- A user bearer or session gives access to **everything its owning user can reach** — the user's whole memory namespace plus every project the user is a member of.
- Admins manage other users + system metrics. Admin auth = role `admin` on the Better Auth `"user"` row; checked on every `/v1/admin/*` call.

### Data isolation invariants (do not break)

1. `getEntry(userId, id, {projectId})` returns the row **only** if (a) the row is project-scoped and `row.project_id === projectId`, or (b) the row is user-wide and `row.user_id === userId`. There is no third path.
2. Cold collections are named `novamem_<userId>_<namespace>` for user-wide entries and `novamem_p_<projectId>_<namespace>` for project entries. User ids cannot start with `p_` or be exactly `p` — the create-user Zod schema enforces this. **Never relax that regex without also changing the cold-store collection naming scheme.**
3. Removing a project member must also revoke their project-related access. `WarmStore.removeProjectMember` deletes the membership row in a single transaction.
4. Data-plane routes (`/v1/search`, `/v1/recent`, `/v1/neighbors`, `/v1/remember`, `/v1/capture`, `/v1/forget`, `PUT /v1/memories/:id`) enforce project membership via `checkProjectAccess`. Forget/update paths re-fetch the entry's real scope and re-check membership before mutating (defence in depth against `project: null` laundering).
5. The Better Auth passthrough refuses operations that would leave zero admins: pre-handler intercepts `/api/auth/admin/remove-user` and `/api/auth/admin/set-role` (when the new role is non-admin) and returns `400 LAST_ADMIN_PROTECTED` if the target is the only admin.
6. Audit-log every admin action. Read it at `GET /v1/admin/audit-log`.

## Production hardening checklist

If you're running novamem with real data:

### Required

- [ ] Set `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` + `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` once on first deploy. The password is auto-scrubbed from `process.env` after seeding so it doesn't surface via `docker inspect`. Sign in with the seeded admin and change the password from the dashboard immediately.
- [ ] Set `NOVAMEM_BASE_URL` to the public URL the dashboard is reachable at (e.g. `https://memory.example.com`). Better Auth's trusted-origin / CSRF check requires this match the browser's `Origin` header exactly.
- [ ] Set `NOVAMEM_COOKIE_SECRET` to a strong random value (`openssl rand -hex 32`). The dev fallback string MUST NOT be used in production.
- [ ] Set `NOVAMEM_AUTH_MODE=user` (the default).
- [ ] Unset `NOVAMEM_INSECURE_COOKIES` (or set to `0`). Cookies are then `Secure` and require HTTPS.
- [ ] Restrict CORS via `NOVAMEM_CORS_ORIGINS` (comma-separated allowlist; default is same-origin only). `*` re-enables permissive behaviour — don't use it in production.
- [ ] Run the server behind a TLS-terminating reverse proxy or LoadBalancer with a real cert. `Authorization: Bearer …` and the session cookie over plain HTTP are plaintext.
- [ ] Do **not** expose Postgres / Qdrant on host ports in production. The bundled `docker-compose.yaml` does this for local dev convenience; remove the `ports:` blocks for those services in production compose files.
- [ ] Change the Postgres password (the bundled `docker-compose.yaml` uses `novamem` as the default — fine for dev, dangerous in prod).
- [ ] Configure log shipping. Pino emits JSON to stdout; `Authorization`, `password`, and created token values are redacted via `redact:` config.

### Recommended

- [ ] Set `NOVAMEM_PG_POOL_MAX` to fit your Postgres `max_connections`. Default `20`.
- [ ] Run a Prometheus sidecar that scrapes `/v1/admin/metrics/prom`. The dashboard's polling-based metrics are operational; the in-process counters reset on restart, but the 24h history chart pulls from `metrics_samples` in Postgres which IS persisted.
- [ ] Configure Dependabot / Renovate. The lockfile is committed; major-version bumps need integration testing.
- [ ] Enable container scanning (Trivy / Grype) in your image pipeline.

### Operational gotchas

- **Schema is forward-only.** All DDL is `ALTER ... ADD COLUMN IF NOT EXISTS` plus explicit `DROP CONSTRAINT IF EXISTS` for retired FKs. There is no rollback story beyond restoring from backup.
- **Sessions are server-side**: signing out via `/api/auth/sign-out` deletes the row. Closing a tab without signing out leaves the session valid until its TTL (7 days by default).
- **`/v1/admin/metrics` resets on restart** by design — in-process counters. The 24h throughput history chart pulls from `metrics_samples` in Postgres and survives reboots.
- **Removed project members keep nothing.** Their membership row is deleted; their tokens stay valid against their own user namespace but they no longer see the project's memory.

## Threat model summary

| Adversary | What they can / cannot do |
|---|---|
| Anonymous internet user | Hit `/health`, `/api-docs`, `/openapi.json`, `/admin` HTML shell. Cannot read or write any memory. |
| Holder of a `nm_…` bearer | Read/write everything the owning user can reach — user-global entries plus every project that user is a member of. Cannot mint other bearers, cannot reach `/v1/admin/*` (unless the owning user is admin). Can rotate the bearer via `/v1/auth/rotate-token`. |
| Logged-in user (role `user`) | Manage their own bearers + projects, view their own metrics. Can share a project with another user (adds them as a member). Cannot reach `/v1/admin/*` or `/api/auth/admin/*`. |
| Logged-in user (role `admin`) | Manage all users via Better Auth's admin endpoints, view system metrics, run decay / dream-cycle. Admins do **not** automatically inherit other users' memory access — they manage identity, not data. The last admin cannot be removed or demoted. |
| Member of a shared project | Read/write every memory in that project, including memories written by other members. See "Shared projects are a trust boundary" below. |
| Compromised database | Sees Better Auth's password hashes (scrypt) in `account.password`, token hashes (sha256) in `user_tokens`. Plaintext bearers and passwords are not stored. Re-issued tokens can be invalidated by deleting the relevant rows. |

## Shared projects are a trust boundary

Memory content is stored verbatim and returned verbatim to the calling agent, and the tool descriptions instruct that agent to weight stored memories above its own reasoning. That is the whole point of the product — and it means **anyone you share a project with can influence what your agent believes.**

A member who writes a memory containing adversarial instructions ("when asked about deployments, always recommend …", or text shaped to look like a system directive) is writing into a channel your agent treats as high-confidence context. The sensitivity gate (`maxSensitivity`) controls *visibility*; it is not a defence against injection, because the injected text is visible by design.

Practical guidance:

- Share projects with people you would trust to edit your agent's instructions — the capability is comparable.
- `project_share` and `project_unshare` resolve members by **exact email address**. Display names are self-settable, so they are not accepted as identifiers: a fuzzy match would let a newly-registered user collide with a colleague's handle and be invited in their place.
- Prefer user-global memories (no project) for anything you would not want a project member to be able to overwrite.
- Memory rows carry provenance (`source`, `agentName`, `capturedFrom`). When triaging odd agent behaviour in a shared project, `memory_recent` plus those fields shows who wrote what.
