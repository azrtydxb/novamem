# Changelog

All notable changes to novamem are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.1.2] - 2026-05-05

### Fixed

- **`@azrtydxb/novamem-init` configured Claude Desktop with an invalid MCP entry.** The installer wrote `{"type": "sse", "url": …, "headers": …}` to `claude_desktop_config.json`, which Claude Desktop rejects on launch with "not valid MCP server configurations and were skipped: novamem" — its loader only accepts stdio entries (`command`/`args`). Fix: switch the `claude-desktop` adapter from `transport: "sse"` to `transport: "stdio"`, so the bundled `@azrtydxb/novamem-mcp` shim runs locally and bridges to the server. New regression test in `packages/init/test/tools.test.ts`.
- **`docs/connect/claude-desktop.md`** rewritten to match — stdio is the documented path; the SSE example is gone.

## [1.1.1] - 2026-05-05

### Fixed

- **`npx @azrtydxb/novamem-init` exited silently with no output.** The entrypoint guard in `dist/main.js` compared `import.meta.url === \`file://${process.argv[1]}\`` — which never matched when invoked via the symlink npm puts in `node_modules/.bin/`. `runCli` never ran, exit 0, no output. Fix: resolve `process.argv[1]` via `realpathSync` before comparing. Last manual mono-version bump — Changesets is being introduced for per-package versions next.
- **`PKG_VERSION` was hardcoded `"0.1.0"`** in the init CLI; `--version` now reads from the bundled `package.json`.
- **ProjectsPage "Add a member" form** said "by username" / placeholder "carol"; server requires exact email per #62. Now labeled "by email" / "carol@example.com" with `type="email"`. Internal state renamed `username` → `email` to match.
- **`packages/init` test gap.** Added `test/cli.test.ts` regression that runs the CLI through a symlink and asserts `--version` matches `package.json` exactly. The earlier 56 tests imported `runCli` directly and never exercised the bin entrypoint path.

## [1.1.0] - 2026-05-05

Issue cleanup release. 18 GH issues from the post-v1.0.0 audit triaged and closed across docs, server hardening, deploy improvements, observability, and test coverage. Two architectural issues (#68, #69 — single source of truth for the API contract) deferred to a future release.

### Added

- **Request correlation IDs** — every HTTP response carries `X-Request-Id` (8-byte hex; honours a safe inbound `x-request-id` from a trusted proxy with a `/^[A-Za-z0-9_.:-]{1,128}$/` allowlist). Audit-log rows include `requestId` in metadata. Fastify's `req.log` is auto-bound to the same id, so every log line for a request can be grepped together. (#75)
- **Production Docker Compose override** — `docker-compose.prod.yaml` removes datastore host port publishes and pins `falkordb/falkordb:v4.18.3`. Use as `docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d` behind a TLS-terminating proxy. (#72)
- **Docs smoke test** (`pnpm docs:smoke`, also wired into CI) catches stale claims: public `/health` shape, deep-health endpoint path, project-share exact-email wording, lifecycle admin-only, no leftover `Co-Authored-By: Claude` trailers, no leftover `P[0-9]-` review markers. (#73)
- **Release preflight** (`pnpm release:preflight`) verifies aligned versions, CHANGELOG entry for the canonical version, fresh `docs/api/openapi.json`, clean working tree post-build. (#74)
- **Consolidated security regression suite** — `packages/server/src/security.test.ts` asserts the boundaries from #55, #56, #57, #58 in one readable file.
- **TypeScript client contract tests** — `packages/client/test/contract.test.ts` mocks `fetch` and asserts the SDK's URL/method match `docs/api/openapi.json` for every public method. (#71)

### Changed

- **Default Node version for releases** — `release.yml` runs on Node 24 (ships npm 11.x) so Trusted Publishers OIDC handles publish auth, not just Sigstore signing. (#80, #81)
- **Lifecycle scan routes admin-only** — decay was reachable by any authenticated bearer holder (could trigger global scans). It now matches the other lifecycle maintenance routes. (#55)
- **Better Auth admin passthrough** — wildcard `/api/auth/admin/*` replaced with an explicit allowlist of 13 admin endpoints pinned to BA `^1.6.9`. Future BA admin endpoints don't auto-expose. (#58)
- **Public BA sign-up dropped** — `POST /api/auth/sign-up/email` is no longer routed; the bootstrap admin flow uses `ba.api.signUpEmail` in-process. (#56)
- **Vite/esbuild moderate audit findings cleared** — pnpm overrides force `vite ≥ 6.4.2` and `esbuild ≥ 0.25.0`. `pnpm audit --audit-level moderate` returns clean. (#59)
- **Engines floor bumped** to `>=20.19` across all packages to match Vite 8's transitive Node requirement.
- **Docs sweep** — README quickstart, `docs/install/{docker,manual,kubernetes}.md`, `docs/api/README.md`, `docs/architecture.md`, `docs/usage.md`, `skills/novamem/**`, `packages/{client,mcp}/README.md`, `packages/client/src/index.ts` rewritten to match the post-v1.0.0 surface (boolean `/health`, exact-email project sharing, env-required Postgres password). (#60-66)

### Fixed

- **MCP SSE session ownership** — `POST /mcp/messages?sessionId=…` now verifies `session.userId === req.userId`; cross-user POSTs return 403. (#57)
- **`revokeMyToken` return type** in the TS SDK was `{ revoked: boolean }` but the server returns `{ deleted: true }`. Aligned. (#66)

## [1.0.0] - 2026-05-05

End-to-end production deploy on a real k3s cluster surfaced and fixed four real bugs; full-codebase review closed 14 quality + 7 security issues; CI gates and dependabot auto-merge wired so future bumps land safely without manual review.

### Added

- **Per-user SSE concurrency cap** — `/mcp/sse` refuses an 11th concurrent session per `userId` with `429` and reaps any session idle (no `POST /mcp/messages`) for 30 minutes. Prevents an `nm_…` token from exhausting fds on a long-running server.
- **`ApiError` in `@azrtydxb/novamem-admin-ui`** — `api()` throws a typed `ApiError extends Error { status: number; code?: string }` on non-OK HTTP, replacing bare `Error` strings. Toasts and tests can branch on `status`/`code`.
- **`/v1/admin/health/deep`** — admin-only per-dependency snapshot. Public `/health` is now a boolean liveness probe only (no infrastructure detail).
- **Global hardening headers** — `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` on every response. Per-route override before `reply.send` for the rare case it's needed.
- **Admin-UI test suite** — 12 vitest tests covering `api.ts` + presentational components. First runtime coverage for the dashboard.
- **Dependabot auto-merge workflow** — patch/minor PRs auto-merge once required checks go green. Major bumps still require manual review.
- **Branch protection on `main`** — required: `test (amd64/arm64)`, `audit`, `package (npm)`, `docker (amd64/arm64)`. `strict: true`.
- **Project-root `CLAUDE.md`** — rule that no PR merges before all Copilot/Claude review comments are resolved.

### Changed

- **Schema validation hardening** — `RememberBody.metadata` capped at 8KB serialized + 64-char keys; project names NFKC-normalised before the regex check so visually-identical Unicode/ASCII names collide instead of co-existing.
- **Logger unification** — `MemoryEngine` and `GraphStore` log via Fastify's pino child logger (object-first). `console.*` reserved for the early-bootstrap path before the logger exists. All `LOG_LEVEL` / `NOVAMEM_*` env reads centralised in `loadConfig` / `ConfigSchema`.
- **Timer reentrancy guards** — decay, dream-cycle, and metrics-flush loops each have an `inFlight` flag so a slow run can't overlap with the next tick.
- **`recharts` bumped to 3.x** in the admin dashboard. Tooltip formatter signature widened for the v3 type change. Bundle shrinks (MetricsPage 397KB → 365KB gzipped).
- **Cypher param hardening** — `graph-store.neighbors()` uses an allowlist of `{1,2,3}` for `depth`, validates non-finite numerics, and `removeAllForProject` is now user-scoped (defence-in-depth against future Cypher-bug exploits).
- **Admin-only `/v1/dream-cycle`, `/v1/reap-orphans`** — were accessible to any authenticated user; now gated by `adminAuth`.
- **Better Auth passthrough** — replaced wildcard `/api/auth/*` with an explicit allowlist of supported paths.
- **Error-handler tightening** — non-Zod errors return `{error: "internal server error"}` to clients; the full Error is logged server-side only.
- **Safe config defaults** — `auth.mode` now defaults to `user`. The dev cookie-secret fallback is gone; processes refuse to start if `auth.mode != none` and no cookie secret is set. `auth.mode=none` binds only to loopback.
- **K8s deploy** — `deploy/k8s/secrets.yaml` is now a placeholder template (real values via `kubectl create secret` / Sealed Secrets / external-secrets-operator). Postgres DSN moved out of the ConfigMap. Sample Ingress with cert-manager + TLS termination shipped; Service downgraded from `LoadBalancer` to `ClusterIP`.
- **`http.ts` route split** — 1333 LOC reduced to a 493 LOC shell + 5 `routes/` modules. `/v1/me/*` data-plane mirrors collapsed onto `/v1/*` (cookie auth still works on the canonical path).

### Fixed

- **`/v1/me/today` 500** — `WarmStore.listRecentActivity` UNION ALL was ordered by `at` (a JS-side property name) which drizzle does not emit as a SQL column alias; switched to positional `ORDER BY 2 DESC`.
- **Embed-using endpoints 500** — Dockerfile `--omit=optional` stripped `onnxruntime-node` (an optional dep of `@xenova/transformers`); every `/v1/remember` and `/v1/search` call returned `ERR_MODULE_NOT_FOUND`. Removed the flag.
- **Admin-UI HealthPage showed UNKNOWN** — page was hitting `/health` (now `{ok}` only) instead of `/v1/admin/health/deep`.
- **Admin-UI Browse + Graph 404s** — pages still called `/v1/me/{recent,search,remember,neighbors}` (collapsed onto `/v1/*` in this release). Updated all call sites.

### Removed

- **Legacy `NOVAMEM_ADMIN_TOKEN`** — admin routes now require a logged-in admin session. `auth.adminToken` dropped from config; CI scripts must mint a session via Better Auth.
- **Stale `P0/P1/P2` review markers** — 25 review-tracker comments scrubbed across the codebase (mechanical sweep).
- **`Co-Authored-By: Claude` trailers** — git history rewrite stripped the trailer from all 61 commits on `main`. The `v0.1.0` tag still resolves to the original SHA so npm Sigstore provenance attestations remain valid.

## [0.1.0] - 2026-05-04

First public npm release. Three packages on the `@azrtydxb` scope:

- [`@azrtydxb/novamem`](https://npmjs.com/package/@azrtydxb/novamem) — TypeScript client
- [`@azrtydxb/novamem-mcp`](https://npmjs.com/package/@azrtydxb/novamem-mcp) — MCP-stdio shim
- [`@azrtydxb/novamem-init`](https://npmjs.com/package/@azrtydxb/novamem-init) — one-shot interactive installer

Each ships with [Sigstore provenance](https://docs.npmjs.com/generating-provenance-statements) attestations, published via npm Trusted Publishers (OIDC) — no static tokens, no rotation.

### Added

- **`@azrtydxb/novamem-init`** — `npx @azrtydxb/novamem-init` interactively signs you into a novamem server, mints a fresh `nm_…` bearer, detects every installed AI agent host (30 from the agentskills.io ecosystem — Claude Code, Claude Desktop, Cursor, Kilo Code, OpenCode, Codex CLI, Gemini CLI, GitHub Copilot, Cline, RooCode, Continue, Factory, Windsurf, Amazon Q, plus 16 skill-only hosts), and writes the right MCP server entry, skill bundle, and slash commands per host. JSON/TOML merging is idempotent — never clobbers existing config.
- **Tag-driven release workflow** (`.github/workflows/release.yml`) — push a `v*` tag and CI builds, tests, and publishes the three public packages with provenance via OIDC Trusted Publishers.
- **Multi-arch Docker images** at `ghcr.io/azrtydxb/novamem:main` and `:sha-<short>` — built natively on amd64 and arm64 GitHub-hosted runners (no QEMU), Trivy-scanned (HIGH/CRITICAL with `--ignore-unfixed`) before push.
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
- **Direct SSE MCP** — recent clients point at `http://<host>:7778/mcp/sse` with `Authorization: Bearer nm_…` and skip the stdio shim. The shim stays in `@azrtydxb/novamem-mcp` for legacy clients.
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
- `/v1/admin legacy tenant-management routes` routes (multi-tenant predecessor of `/v1/admin/users`).
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
