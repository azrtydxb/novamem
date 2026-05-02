# Comprehensive Code Review — novamem

## Review Target

Whole-repo audit of the **novamem** monorepo: tiered memory service (Postgres + Qdrant + FalkorDB) with HTTP/JSON + MCP transports, multi-tenant + project (sub-brain) isolation, and an embedded React dashboard. Focus on the recent dashboard auth + projects + Swagger work (last two commits, ~11.7k LOC), with full-repo coverage requested.

Flags applied: `--security-focus`, `--performance-critical`, `--strict-mode`.

## Executive Summary

The codebase is well-engineered at the language level (strict TypeScript, careful Zod validation, parameterised SQL almost everywhere, idiomatic React). The recent dashboard + projects feature is feature-complete, has 138 passing tests, and works end-to-end (browser-verified).

**The headline concerns are not code-quality concerns — they are correctness and operational concerns:**

1. **The project-as-isolation contract has implementation gaps.** The conceptual rule ("when a project is set, project IS the access boundary, tenant_id is decorative") is right, but four enforcement sites (`forget` DELETEs, `addRelation` INSERTs, `removeProjectMember` cleanup, cold-store prefix scan) still treat `tenant_id` as the boundary. Two of these are user-visible bugs in the cross-tenant share flow; one is a destructive admin action exploitable via tenant naming.

2. **Authentication hardening stops at "works for the happy path."** Login has no per-username throttle. Sessions never garbage-collect. The bootstrap admin password sits in `process.env`. Logger has no `redact` rule. CSP allows `unsafe-inline`. Each is fine alone; together they form a brute-force-and-XSS-into-account-takeover ladder.

3. **Hot-path queries are O(rows) where they could be O(1).** Decay loop fires one UPDATE per cold candidate (1M rows = 1M round-trips); search does N+1 lookups; metrics polls hit `SELECT COUNT(*)` on every dashboard tick. All have idiomatic SQL fixes worth 100×–1000× speedups at scale.

4. **CI is weak relative to ambition.** A pre-existing CI workflow runs typecheck + tests, but there's no lint, no audit, no container scanning, no Dependabot, no release flow. The container itself runs as root and ships test code in the runtime image.

5. **Documentation tracks the code into the wall.** Critical security invariants (the project-isolation rule, the `p_*` tenant collision, the kicked-member token leak) exist in code comments at best, in nobody's runbook. There's no `SECURITY.md`, no per-package READMEs, no CHANGELOG, no ARCHITECTURE doc, and one OpenSpec arc that was overtaken by later work.

The good news: the **shape** of the system is sound. Most fixes are surgical (specific files / handlers / query patterns), not architectural. Strict TypeScript catches the large class of errors that aren't on this list.

## Findings by Priority

### P0 — Critical (Must Fix Immediately)

| ID | Source | Issue | Where |
|---|---|---|---|
| **P0-1** | S-C1 / A2 | Cold-store collection prefix collision: tenant id `p_*` matches `novamem_p_<project>_*`. Admin who creates+deletes tenant `p_x` wipes shared-project vector data across all tenants. | [src/cold-store.ts:131](packages/server/src/cold-store.ts#L131), [src/http.ts:110 (tenant-id regex)](packages/server/src/http.ts#L110) |
| **P0-2** | S-C2 / C2 | `removeProjectMember` does NOT revoke the kicked user's project-scoped tokens. Removed collaborators retain access. | [src/warm-store/index.ts:694](packages/server/src/warm-store/index.ts#L694) |
| **P0-3** | S-C3 | No per-username login throttle. Only the global 600/min IP rate limit applies. Login is brute-forceable. | [src/http.ts /v1/auth/login](packages/server/src/http.ts) |
| **P0-4** | S-C4 / A1 | `getEntry`'s `projectId === "*"` magic-string disables both tenant and project access checks. No live caller, but one wrong refactor = full data-isolation bypass. | [src/warm-store/index.ts:847](packages/server/src/warm-store/index.ts#L847) |
| **P0-5** | S-H2 / A3 / A11 | `engine.forget` DELETEs filter by bearer's `tenant_id` even on project rows; cross-tenant project member's forget silently no-ops while returning `deleted: true`. `addRelation` INSERTs have the symmetrical bug. | [src/engine/index.ts forget()](packages/server/src/engine/index.ts), [src/warm-store/index.ts addRelation()](packages/server/src/warm-store/index.ts) |
| **P0-6** | P-C1 | Decay loop issues one UPDATE per cold candidate. With 1M warm rows = 1M round-trips. Single SQL UPDATE-FROM is 500–1000× faster. | [src/engine/index.ts decay()](packages/server/src/engine/index.ts) |

### P1 — High (Fix Before Next Release)

Security:
- **P1-S1** `/mcp/messages` accepts a sessionId without verifying the request bearer matches the session's captured bearer (cross-session smuggling).
- **P1-S2** Pino logger has no `redact` for Authorization headers, password fields, or minted token plaintexts.
- **P1-S3** `cors: { origin: true }` reflects every Origin; combined with Swagger UI's `'unsafe-inline'` style-src on the same origin and sessionStorage tokens, post-XSS account takeover is one-step.
- **P1-S4** Sessions never GC'd (`expires_at` fixed at creation, no sweep). Eventually unbounded.
- **P1-S5** `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` survives in `process.env` for the process lifetime; visible via `docker inspect`.
- **P1-S6** Zero audit logging of admin actions (tenant/user CRUD, role changes, token mint/revoke).

Architecture / Quality:
- **P1-A1** `http.ts` is a 974-LOC mega-function with the security-critical auth hook nested 6 levels deep. Split by route group.
- **P1-A2** `ftsSearch` builds SQL via runtime regex string-replace on column names — fragile under future edits.
- **P1-A3** Project-vs-tenant scoping rule is restated four times across stores. Recommended `Scope` value object.
- **P1-A4** Engine bypasses warm-store with raw SQL for `recent()`. Couples engine to the SQL layer.
- **P1-A5** 822-LOC `test-fakes.ts` parses production SQL via substring matching — fragile, and DIRECTLY enabled multiple Phase 2 bugs to evade detection.
- **P1-A6** `graph-store.ts` `removeAllForTenant` / `removeAllForProject` swallow ALL errors → engine reports `graphCleared: true` even when nothing was cleared.
- **P1-A7** **DDL ordering bug**: `ALTER TABLE memory_entries ADD COLUMN` runs BEFORE `CREATE TABLE memory_entries` in `WarmStore.initialize()`. Crashes on a fresh DB (pre-existing tables save us today).

Performance:
- **P1-P1** `engine.search` does N+1 round-trips per fused result (`getEntry` + `bumpHits` per id). Batch.
- **P1-P2** Metrics polling drives `SELECT COUNT(*) FROM memory_entries WHERE cold=…` every 5s per dashboard tab. Add in-process gauges OR a `(tenant_id, cold)` composite index.
- **P1-P3** `linkVectorNeighbors` issues 3 sequential Cypher round-trips per `remember()`. Single `UNWIND` MERGE collapses to one.
- **P1-P4** `pg.Pool` has no explicit `max` — silent connection-pool exhaustion under load.
- **P1-P5** `WarmStore.initialize()` runs DDL on every boot with AccessExclusive locks; serialises K8s rollouts. Wrap in `pg_advisory_xact_lock`.

Tests:
- **P1-T1** No regression tests for any of P0-1, P0-2, P0-4, P0-5 (kicked-out token leak, prefix collision, magic-string bypass, cross-tenant forget). Each is a one-shot vitest case.
- **P1-T2** Two packages have zero tests: `admin-ui` (`"test": "echo 'no tests' && exit 0"`) and `@azrty/novamem`.
- **P1-T3** No `auth.test.ts`. Bcrypt edge cases (72-byte truncation, empty/very-long inputs) untested.

Docs:
- **P1-D1** No `SECURITY.md`, no security-disclosure channel, no security-model section.
- **P1-D2** README does not warn that tenant id `p_*` is dangerous (P0-1) or that removed members keep token access (P0-2).
- **P1-D3** `@azrty/novamem` and `@azrty/novamem-mcp` ship to npm with no READMEs.

DevOps:
- **P1-O1** Container runs as root in runtime stage; `USER node` missing.
- **P1-O2** Runtime image ships `tsx`, `vitest`, `@types/*`, full `src/*.ts`. Should be `dist/` + production deps only.
- **P1-O3** No supply-chain guardrails — no Dependabot, no `npm audit` step, no Trivy/Grype container scan.
- **P1-O4** All three backing stores exposed on host ports in `docker-compose.yaml` with no production-warning comment.
- **P1-O5** Schema is forward-only DDL; no migration tooling, no rollback story for schema changes.

### P2 — Medium (Plan for Next Sprint)

- **P2-1** No setErrorHandler — Zod parse errors fall through as 500 instead of 400.
- **P2-2** No React Query / TanStack Query — six pages reimplement polling boilerplate. Recommended.
- **P2-3** `recharts` ships eagerly in the main bundle (~40%); lazy-load MetricsPage via `React.lazy`.
- **P2-4** Zod request schemas only in server; client re-types by hand. Drift inevitable.
- **P2-5** MetricsCollector `Map<tenantId, slot>` never frees deleted-tenant slots.
- **P2-6** `tenant_tokens.last_used_at` and `sessions.last_seen_at` updated on every request — write hotspots.
- **P2-7** Reaper ORDER BY `last_attempt_at` is unindexed.
- **P2-8** Auth-hook precedence is implicit — order-of-declarations matters; one wrong move breaks all routes.
- **P2-9** `resolveRequestProject` duplicated across HTTP and MCP code paths.
- **P2-10** Engine `deleteProject` / `deleteTenant` push permission checks out of band (HTTP-layer-only).
- **P2-11** Inconsistent error envelopes (some routes return `{error: string}`, some return Fastify defaults).
- **P2-12** `WarmStore.db` and `.pool` exposed as public — engine reaches around the abstraction.
- **P2-13** Two ways to revoke a token (REST path + RPC body) — drop one.
- **P2-14** `since` query parameter in `recent()` is unvalidated as ISO-8601.
- **P2-15** No `HEALTHCHECK` in Dockerfile; `/health` exists but isn't declared.
- **P2-16** No `.env.example` at repo root; no `.dockerignore`.
- **P2-17** `sseTransports` Map at http.ts:921 not iterated on shutdown — in-flight SSE connections aren't drained.
- **P2-18** No Prometheus exporter / OpenTelemetry — observability stops at the dashboard.
- **P2-19** OpenAPI doc has zero `examples:` blocks; single `Error` schema with no per-route 4xx enumeration.
- **P2-20** Project-as-isolation invariant is comment-noted in only 2 of ~8 enforcement sites — silent at the others.
- **P2-21** No backup / restore / rollback / migration runbook.
- **P2-22** No CHANGELOG.md; no operator-readable record of behaviour shifts.
- **P2-23** OpenSpec change `add-admin-dashboard` is overtaken by sessions+projects+Swagger work; readers may mistake it for current architecture.
- **P2-24** No CI lint step; no integration test step; no release workflow.

### P3 — Low (Track in Backlog)

- Drizzle re-exports as instance fields (`asc`, `desc`, `eq` on WarmStore).
- `seenCollections` cache never invalidates beyond delete paths.
- Hand-written OpenAPI document drifts from Zod over time.
- StrictMode in dev double-invokes effects (production unaffected).
- Outdated deps survey: React 18→19, Vite 6→8, Tailwind 3→4, recharts 2→3, Zod 3→4, Drizzle 0.36→0.45, lucide-react 0.468→1.14, bcryptjs (now archived).
- No skip-link / `aria-live` regions for toast in admin-ui.
- Server `package.json` implicitly `private: false`.
- No `CODEOWNERS`.
- The auth-mode table in README doesn't mention session bearers.
- Project deletion's cross-tenant blast radius isn't loud enough in dashboard copy.

## Findings by Category

| Category | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Code Quality | 2 | 8 | 9 | 6 | 25 |
| Architecture | 3 | 8 | 8 | 4 | 23 |
| Security | 4 | 9 | 11 | 6 | 30 |
| Performance | 1 | 7 | 9 | 5 | 22 |
| Testing | 4 | 9 | 6 | 2 | 21 |
| Documentation | 2 | 4 | 6 | 3 | 15 |
| Best Practices | 0 | 4 | 6 | 10 | 20 |
| CI/CD & DevOps | 0 | 8 | 7 | 4 | 19 |
| **Totals (raw)** | **16** | **57** | **62** | **40** | **175** |

After cross-phase deduplication (e.g. S-C1 = A2, S-C2 = C2, S-H2 = A3 = T-C2):

| Severity | Unique findings |
|---|---|
| **Critical (P0)** | **6** |
| **High (P1)** | ~40 |
| **Medium (P2)** | ~55 |
| **Low (P3)** | ~35 |

## Recommended Action Plan

**Sprint 0 (this week — P0 stop-the-bleed):**

1. Fix the cold-store collection prefix collision (P0-1). Either (a) tighten the tenant-id regex to forbid leading `p_` or `p` exactly, or (b) change project collection naming to `novamem__p__<project>_<ns>` (double underscore is impossible from any valid slug).
2. Revoke project-scoped tokens when `removeProjectMember` runs (P0-2). One `UPDATE tenant_tokens SET revoked_at = now() WHERE created_by_user_id = $userId AND project_id = $projectId`.
3. Add per-username login throttle (P0-3). Track failed-login counts in a small in-memory ring (or postgres if HA matters); progressive backoff after 5 failures.
4. Remove the `"*"` magic-string from `getEntry` (P0-4); replace with a typed internal API.
5. Fix `engine.forget` and `addRelation` to filter by `project_id` when the entry/relation is project-scoped (P0-5). Two surgical fixes.
6. Rewrite `engine.decay()` as a single `UPDATE memory_entries SET cold = true FROM memory_access WHERE …` (P0-6). 100-line PR; 500–1000× speedup.

Each P0 should also get a regression test (T-C1..T-C4 + decay perf assertion).

**Sprint 1 (next — P1 hardening):**

7. Pino `redact` paths for Authorization, password, and minted tokens (P1-S2). 5-line config change.
8. Tighten CSP / scope CORS / consider HttpOnly+SameSite cookie sessions instead of sessionStorage (P1-S3).
9. Sliding session expiry + a daily GC sweep on the `sessions` table (P1-S4).
10. `delete process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` after `bootstrapAdmin` runs (P1-S5).
11. SSE-MCP bearer-rebind verification on `/mcp/messages` (P1-S1).
12. Fix the DDL ordering: move all `ALTER TABLE memory_entries ADD COLUMN` statements after the `CREATE TABLE memory_entries` statement (P1-A7). 30-second fix; existing deploys are unaffected.
13. Connection pool max + reaper index (P1-P4, P2-7).
14. Audit log for admin actions (P1-S6).

**Sprint 2 (CI hardening + docs):**

15. Add lint step + `npm audit --audit-level=high` step + Dependabot config to existing CI workflow (P1-O3).
16. `USER node` in Dockerfile + drop test deps from runtime image (P1-O1, P1-O2).
17. `SECURITY.md` + per-package READMEs for `@azrty/novamem` and `@azrty/novamem-mcp` (P1-D1, P1-D3).
18. Document the project-isolation invariant in a single commented constant + cite it at every enforcement site (P2-20).

**Sprint 3 (refactor — P1-A1, P1-A3, P1-A5):**

19. Split `http.ts` by route group (auth, me, admin, memory, mcp).
20. Replace the SQL-shim test fakes with PGlite for warm-store tests.
21. Introduce a `Scope` value object that captures `(tenantId, projectId | null)` and pass it through warm/cold/graph/engine instead of restating the rule four times.

**Backlog (P2 / P3):** TanStack Query migration, lazy-loading MetricsPage, OpenAPI examples, ARCHITECTURE.md, CHANGELOG, dependency upgrades.

## Review Metadata

- Review date: 2026-05-02
- Phases completed: 1 (Quality + Architecture), 2 (Security + Performance), 3 (Tests + Docs), 4 (Best Practices + CI/CD), 5 (Consolidated)
- Flags applied: `--security-focus`, `--performance-critical`, `--strict-mode`
- Sub-agents used: code-reviewer, architect-review, security-auditor, general-purpose × 4
- Files inspected: ~50 TS/TSX files across 4 workspace packages, plus Dockerfile, docker-compose.yaml, .github/workflows/ci.yml, README.md, openapi.ts spec
- Total findings (raw): 175 across 8 categories
- Critical findings (deduplicated): 6
- Tests passing at review time: 138 (server) — `pnpm -r test` clean
