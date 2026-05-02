# Phase 3b — Documentation Review

Scope: top-level `README.md`, `packages/server/src/openapi.ts` (live OpenAPI 3.0 doc + Swagger UI at `/api-docs`), inline TS comments, `openspec/changes/add-admin-dashboard/`. No per-package READMEs, no `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, or `docs/` tree.

The README is unusually thorough for a pre-1.0 project — quickstart, multi-tenant model, projects/sub-brains, MCP transports, dashboard, and metrics are all covered with runnable snippets. The gaps below are mostly about (a) operator-facing security gotchas surfaced in Phases 1–2, (b) missing per-package docs that block npm publish, and (c) the absence of any artifact that explains the *current* architecture (the only OpenSpec change is now stale by intent).

| # | Severity | Area | Title |
|---|---|---|---|
| D1 | Critical | README / Security | Tenant-id naming rule is not documented as security-sensitive (`p_*` collision) |
| D2 | Critical | README / Security | Removed-project-member tokens keep working — undocumented gotcha |
| D3 | High | README / Security | Bootstrap admin password lifecycle (env var → `docker inspect`) not called out |
| D4 | High | Project docs | No `SECURITY.md`, no security-model section, no disclosure channel |
| D5 | High | Per-package docs | `@azrty/novamem` (client) ships to npm with no README — renders blank on the registry |
| D6 | High | Per-package docs | `@azrty/novamem-mcp` ships with no README; `novamem-login` only documented in main README |
| D7 | Medium | Architecture | No `ARCHITECTURE.md` / ADRs; only stale OpenSpec captures original design — readers of `openspec/` will be confused |
| D8 | Medium | OpenAPI | No `examples:` blocks on any route; error response is `{error: string}` with no per-route enumeration of codes |
| D9 | Medium | Inline | Project-as-isolation invariant is comment-noted in 2 of ~8 enforcement sites; the rest are silent |
| D10 | Medium | Operations | No backup/restore, rollback, or migration runbook — only docker-compose quickstart |
| D11 | Medium | Release notes | No `CHANGELOG.md`; sessions + projects + Swagger shifts only visible via `git log` |
| D12 | Medium | README / Operations | No external-monitoring story (Prometheus exporter, scraping warning, in-process reset on restart only mentioned once) |
| D13 | Low | README | Project deletion = full data purge across 3 stores — wording is technical, not scary enough for a destructive admin action |
| D14 | Low | README | Auth scheme table covers `none`/`bearer`/`tenant` modes but not the *session* (`ns_…`) bearer next to `nm_…` — concept introduced under "Dashboard auth" without a header reference |
| D15 | Low | OpenSpec | No README in `openspec/changes/add-admin-dashboard/` flagging it as a frozen historical record (not current architecture) |

---

## Critical

### D1 — Tenant-id naming rule is not documented as security-sensitive
Severity: **Critical**
File(s): `/Users/pascal/Development/novamem-1/README.md` (Bootstrap a tenant deployment, Isolation guarantees)

Phase 2 S-C1 / Phase 1 A2 found that an admin who creates tenant id `p` or `p_<anything>` triggers a destructive prefix collision in `cold-store.ts` `deleteAllForTenant` — wiping shared-project vector data across all tenants. The README's tenant-create example (`{"id":"acme",...}`) gives no validation hint. Operators choosing tenant ids have no warning that `p_*` is reserved.

**Recommendation**: in the "Bootstrap a tenant deployment" section, add a callout: `> **Reserved tenant ids:** ids starting with p_ collide with project-scoped collection names and are refused at create time. Use a more specific prefix for tenant slugs.` (Pair this with a server-side regex tightening — see S-C1.) Also document the slug regex (`^[a-z0-9][a-z0-9_-]*$`, 2–64 chars) so operators don't have to read source.

### D2 — Removed-project-member tokens keep working
Severity: **Critical**
File(s): `/Users/pascal/Development/novamem-1/README.md` (Projects → "From the dashboard", Authentication & multi-tenancy → Isolation guarantees)

Phase 2 S-C2 / Phase 1 C2 found that `removeProjectMember` deletes the membership row but does not revoke the kicked member's project-scoped `nm_…` tokens. The README presents "expand it and add a member by username" with no symmetric warning that removing a member leaves their device tokens functional.

**Recommendation**: add a security note under the Projects section: `> **Removing a member does not revoke their existing project tokens.** Until the implementation is fixed, treat token revocation as the authoritative kick: list the user's tokens via /v1/admin/tenants/<theirTenant>/tokens and revoke each one whose scope is this project. Compromised collaborators must be off-boarded by token, not by membership.` Also add a `### Security model` subsection (see D4) covering what an admin / member / removed-member can each do.

---

## High

### D3 — Bootstrap admin password lifecycle is not called out
Severity: **High**
File(s): `/Users/pascal/Development/novamem-1/README.md` (Bootstrap an admin user, lines 168–181)

Phase 2 S-H6: `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` survives in `process.env` for the entire process lifetime — visible to anyone with `docker inspect <container>` or shell access. The README presents the env var as the canonical bootstrap path with no warning to rotate or unset it.

**Recommendation**: append to the bootstrap admin section: `> **Treat the bootstrap password as one-shot.** It is hashed at first boot but the plaintext stays in the container's env (visible via docker inspect and /proc/<pid>/environ). After your first sign-in, change it from the dashboard, then unset NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD in your compose / k8s manifest and re-deploy.` Also recommend a complexity floor (or document that none is enforced, so caller-supplied entropy matters).

### D4 — No SECURITY.md, no security-model section, no disclosure channel
Severity: **High**
File(s): repository root (no file); `README.md` (no `## Security model` section)

For a multi-tenant memory service the README has zero prose explaining the security model: what isolation projects buy you, what an admin can do (delete any tenant's data), what a malicious project member can do (read all project memories regardless of tenant — by design), what a removed member can still do (D2), where to report vulnerabilities. There is no `SECURITY.md` and no email/contact for disclosure.

**Recommendation**: add a `SECURITY.md` at repo root with (a) supported-versions matrix, (b) disclosure channel (email or GitHub private advisory), (c) "What an admin/user/project-member/anonymous can do" table, (d) known acceptances (cross-tenant project sharing is *deliberate*; admins are trusted; metrics reset on restart). Link it from README. Add a `## Security model` subsection in the README itself summarising the threat model in 6–10 lines.

### D5 — `@azrty/novamem` client has no README
Severity: **High**
File(s): `/Users/pascal/Development/novamem-1/packages/client/` (no README.md)

The package is published to npm. With no README, `npmjs.com/package/@azrty/novamem` renders nothing — a blocker for adoption. The package now covers data plane + auth + projects + tokens, none of which is discoverable without grepping the source.

**Recommendation**: write `packages/client/README.md` with: install (`pnpm add @azrty/novamem`), constructor + token shape (`nm_…` vs `ns_…`), one example each for `remember/search/recent/neighbors/forget`, `login`, `createProject`, `mintToken({projectId})`. Mirror the README's "Use from any TypeScript agent" snippet so the canonical example lives next to the code.

### D6 — `@azrty/novamem-mcp` has no README
Severity: **High**
File(s): `/Users/pascal/Development/novamem-1/packages/mcp/` (no README.md)

Same npm-renders-blank issue as D5. The `novamem-login` helper binary is only documented in the top-level README's "From a CLI / skill / MCP host" subsection — npm consumers won't find it.

**Recommendation**: `packages/mcp/README.md` covering: stdio config snippet (lifted from README), SSE config, the seven memory tools + two project tools, and a "Logging in" subsection that documents `novamem-login` (env vars: `NOVAMEM_BASE_URL`, `NOVAMEM_USERNAME`, `NOVAMEM_PASSWORD` or interactive prompt; stdout = token, stderr = log).

---

## Medium

### D7 — No ARCHITECTURE.md / ADRs; OpenSpec is the only design artifact and it's stale by intent
Severity: **Medium**
File(s): `/Users/pascal/Development/novamem-1/openspec/changes/add-admin-dashboard/{proposal.md,design.md,specs/,tasks.md}`; no `docs/architecture.md`, no `docs/adr/`

The only architecture-like artifact in the repo describes the *original* admin-dashboard arc (admin-token gated UI, Preact+htm, 3 tabs). The system has since shipped: bcrypt sessions, users + roles, projects (sub-brains) with cross-tenant membership, project-scoped tokens, Vite/React/Tailwind rewrite, Swagger UI, OpenAPI doc. A reviewer reading `openspec/` to understand novamem will form an incorrect mental model.

**Recommendation**: (a) add `docs/architecture.md` summarising the *current* system: tier model (warm/cold/graph + decay law), per-tenant + per-project isolation, auth modes + token types (`nm_` / `ns_`), data flow on `remember`/`search`, the `(tenant, project)` access boundary; one diagram covering Postgres + Qdrant + FalkorDB + server + admin-ui. (b) Start a `docs/adr/` log; minimum first three ADRs: (i) why per-tenant Qdrant collections (collection-prefix isolation); (ii) why projects are an isolation primitive *separate from* tenants (cross-tenant sharing); (iii) bcrypt 10 rounds (vs argon2id) — record the trade-off. (c) Drop a one-line note at the top of `openspec/changes/add-admin-dashboard/proposal.md` clarifying it's a frozen change record (see D15).

### D8 — OpenAPI: no examples, no per-route error enumeration
Severity: **Medium**
File(s): `/Users/pascal/Development/novamem-1/packages/server/src/openapi.ts` (entire file, ~716 LOC)

Three observations after a full read:
1. Every request body is a `$ref` schema — zero `examples:` blocks. Swagger UI's "Try it out" works, but copy-paste-ready payloads are absent. (Particularly painful for `weights`, `since`, `project` fields which are optional and underspecified.)
2. The `Error` schema is `{error: string}`. Routes return per-error strings (`"bearer is scoped to project '<id>'"`, `"membership required"`, `"refused: tenant 'public'"`, `"reserved tenant id"` if D1 is acted on) but consumers can only learn them by hitting them. No `enum` of error codes, no per-route 4xx documentation beyond `{401, 403, 404}` shells.
3. Several routes return ad-hoc shapes (`{revoked: true}`, `{ready, bootstrapNeeded}`) only in `description` strings — not formal schemas, so SDK generators emit `any`.

**Recommendation**: (a) add an `examples:` block to each `requestBody` (one canonical happy-path payload). (b) Promote `Error` to a tagged union: `{ error: string; code: "forbidden_project" | "tenant_reserved" | "membership_required" | … }`, and document the codes in a top-level `## Error codes` section. (c) Define `RevokeResponse`, `ReadyResponse` etc. as named schemas instead of inlining in `description`.

### D9 — Project-as-isolation invariant is documented in 2 of ~8 enforcement sites
Severity: **Medium**
File(s): `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts` (`getEntry` + `ftsSearch` have rule comments; `addRelation`, `forget`-path DELETEs, `recent`, `removeProjectMember`, `listProjectsForUser` do not), `packages/server/src/cold-store.ts` (no comment near `deleteAllForTenant` prefix scan despite S-C1 risk), `packages/server/src/engine/index.ts` (`forget`, `linkVectorNeighbors` filter by tenant_id silently), `packages/server/src/mcp.ts:165–184` (`resolveProject` *is* well-commented — keep)

Phase 1/2 multiple findings (A1, A3, A11, S-H2, S-H7) trace back to the same forgotten rule: **on a project-scoped row, the access boundary is `project_id`, not `tenant_id`**. The two best-commented call sites are correct; the under-commented ones drift.

**Recommendation**: at the top of `warm-store/index.ts` and `engine/index.ts` add a short docblock literally titled `// Access-boundary invariant`: "for any row with `project_id IS NOT NULL`, project_id is the sole access key (never combine with tenant_id in WHERE clauses); for rows with `project_id IS NULL`, tenant_id is the access key." Then drop a one-line `// invariant: project-scoped — filter by project_id only` at each enforcement site. Add the same comment above `cold-store.ts` `deleteAllForTenant`'s prefix scan calling out the `p_*` collision (D1).

### D10 — No operations runbook (backup/restore, rollback, migrations)
Severity: **Medium**
File(s): `/Users/pascal/Development/novamem-1/README.md` (Quickstart + Dashboard sections only); no `docs/operations.md`

Docker-compose quickstart is documented; nothing else. A production operator gets:
- No backup/restore guide for Postgres + Qdrant + FalkorDB (three-store consistency: a Postgres backup taken at T1 paired with a Qdrant snapshot at T2 will have dangling references).
- No rollback story. Phase 1 P-H7 (DDL on every boot, AccessExclusive locks) means rolling deploys serialise — operators need to know.
- No migration story for the schema-altering boots. The `ALTER TABLE` ordering bug (M4/A9) will manifest on truly fresh DBs.
- No K8s / Helm artifacts (acceptable as out-of-scope, but the README should say "compose only — bring your own K8s manifests" rather than imply parity).

**Recommendation**: add `docs/operations.md` covering: (a) consistent backup procedure (quiesce remembers, snapshot Postgres, then Qdrant, then graph; or: rely on idempotent re-derivation from warm); (b) restore order + which store is source-of-truth (warm); (c) rollback hazard from one-way `ALTER TABLE`s (call out which migrations are not reversible); (d) DDL boot-lock note + recommendation to wrap in `pg_advisory_xact_lock` for K8s rolling deploys; (e) explicit "K8s/Helm not included" disclaimer.

### D11 — No CHANGELOG.md
Severity: **Medium**
File(s): repository root (none)

The recent `git log` shows substantial behaviour shifts: cold→warm promotion, orphan reaper, sessions + projects + Swagger UI, auth hardening. None of this is summarised anywhere a user upgrading their pinned version can read.

**Recommendation**: add `CHANGELOG.md` (Keep-a-Changelog format) with an `Unreleased` section, then snapshot the major shifts since the original `add-admin-dashboard` arc as a `0.x` entry: "Added: session auth (`ns_` tokens), projects with cross-tenant sharing, Swagger UI, …". Going forward, gate releases on a CHANGELOG entry. (CI hint: there is a `documentation-generation:changelog-automation` skill available.)

### D12 — No external-monitoring story
Severity: **Medium**
File(s): `/Users/pascal/Development/novamem-1/README.md` (Dashboard section, lines 304–336)

The README correctly notes "metrics live in-process and **reset on every restart**". It then says "scrape `/v1/admin/metrics` into Prometheus / your TSDB of choice" without explaining: (a) the endpoint emits JSON not the Prometheus exposition format — direct scraping does not work; (b) scraping requires a long-lived admin token in your scrape config (security implication); (c) per-tenant counters use the *bearer's* tenant, not the entry's owner tenant (Phase 1 A14) — meaningfully wrong for cross-tenant projects.

**Recommendation**: add a short `### External monitoring` subsection: explicitly state "no Prometheus exporter ships; you can either run a sidecar that scrapes the JSON and re-emits, or wait for a built-in `/metrics` exposition-format route (tracked: <issue>)". Document A14 caveat. Recommend a dedicated read-only admin token for scrape configs.

---

## Low

### D13 — Project deletion wording is technical, not loud enough
Severity: **Low**
File(s): `/Users/pascal/Development/novamem-1/README.md` (Dashboard section says "type-to-confirm — purges all data" for tenants, but project deletion is mentioned only in the route list `DELETE /v1/me/projects/:id` and Projects → "From the dashboard" gives no warning)

A project delete cascades across warm + cold + graph for every member of that project — including users in other tenants who may not realise their data lives inside someone else's project. The README never names this explicit cross-tenant blast radius for the *project owner*.

**Recommendation**: in the Projects section add a callout: `> **Deleting a project deletes its memories for every member, across every tenant.** A cross-tenant collaborator's contributions go too. Members are NOT notified; consider listing members first and warning them.` Mirror the loud "type-to-confirm" UX from tenant delete in the Projects tab.

### D14 — Auth section doesn't reference session bearers in the mode table
Severity: **Low**
File(s): `/Users/pascal/Development/novamem-1/README.md` (lines 103–112: the `none/bearer/tenant` table; lines 159–166: dashboard auth subsection)

The headline auth table (`NOVAMEM_AUTH_MODE`) only enumerates tenant-token-style auth. The session bearer (`ns_…`) is introduced two subsections later under "Dashboard auth" with no forward reference. Readers building agents pick a mode from the table and are surprised to learn there's a fourth credential type that gates `/v1/auth/*`, `/v1/me/*`, and `project.*` MCP tools.

**Recommendation**: add a row or footnote to the mode table: "Independently of mode, the dashboard issues `ns_…` session bearers (24h TTL) for `/v1/auth/*` and `/v1/me/*`; see [Dashboard auth](#dashboard-auth-admin--user-logins)." Consider a small "## Token types at a glance" table near the top: `nm_…` (tenant) | `ns_…` (session) | `NOVAMEM_ADMIN_TOKEN` (legacy admin) | `NOVAMEM_AUTH_TOKEN` (`bearer` mode shared).

### D15 — OpenSpec change directory looks current; isn't
Severity: **Low**
File(s): `/Users/pascal/Development/novamem-1/openspec/changes/add-admin-dashboard/{proposal.md,design.md,specs/,tasks.md}`

All four artifacts read like a live spec. They describe Preact+htm, sessionStorage admin token, three tabs, no per-tenant users — none of which match shipped reality (React+Vite+Tailwind, bcrypt sessions, four+three tabs, per-tenant users, projects). A reviewer skimming `openspec/` to learn the system will be misled.

**Recommendation**: add a one-line top banner to `proposal.md`: `> **Status: archived/historical.** This change shipped; the codebase has since added sessions, projects, and Swagger UI — see docs/architecture.md (D7) for current state.` Or move the directory to `openspec/archived/` if the workflow supports it.

---

## Summary

15 findings: **2 Critical, 4 High, 6 Medium, 3 Low**. The README is genuinely good for a pre-1.0 — quickstart, MCP, projects, dashboard, metrics all covered with runnable code. The dominant gaps are:

1. **Security gotchas surfaced in Phases 1–2 are not yet reflected in operator-facing docs** (D1, D2, D3, D4) — even before fixing the code, naming the hazards in prose protects users.
2. **No per-package READMEs** (D5, D6) — npm publish renders nothing for the two packages users will actually `pnpm add`.
3. **No current-architecture artifact** (D7, D15) — the only design doc is for the original admin-dashboard arc and is now misleading.
4. **OpenAPI is structurally complete but lacks examples and error enumeration** (D8) — Swagger UI's "Try it out" works, copy-paste does not.
5. **Operations and release-notes story is absent** (D10, D11, D12) — production operators get no backup/rollback/migration/monitoring guidance.

Highest leverage next steps: write `SECURITY.md` (D4 closes D1+D2+D3 inline), write `packages/client/README.md` and `packages/mcp/README.md` (D5+D6, both small), drop a one-line "frozen historical record" banner on the OpenSpec proposal (D15, trivially small). Architecture doc + ADRs (D7) and operations runbook (D10) are larger but high-value for any reader past first-week onboarding.
