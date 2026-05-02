# Phase 2: Security & Performance Review

Per-phase outputs in `.full-review/02a-security.md` (30 findings) and `.full-review/02b-performance.md` (22 findings).

## Summary

| Source | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 4 | 9 | 11 | 6 |
| Performance | 1 | 7 | 9 | 5 |
| **Total** | **5** | **16** | **20** | **11** |

## Security — Critical Findings

- **S-C1** [src/cold-store.ts:131-146] **Cold-store collection prefix collision.** `deleteAllForTenant` does `name.startsWith("novamem_<tenant>_")`; the tenant-id regex (`^[a-z0-9][a-z0-9_-]*$`) allows tenant id `p` or `p_anything`, which matches the project-scoped collection prefix `novamem_p_<project>_*`. **An admin who creates tenant `p` and then deletes it wipes shared-project vector data across all tenants.** Confirmed exploitable. Fix: tighten the tenant-id regex to forbid leading `p_` or use a different sentinel for project collections (e.g. `novamem__p__<projectId>_<ns>`).
- **S-C2** [src/warm-store/index.ts:694-700] **Removed project member retains access via their tokens.** `removeProjectMember` deletes the membership row only; `resolveTenantToken` doesn't recheck membership at request time, so a kicked member's existing project-scoped tokens (`nm_…`) still authorise project reads/writes. Fix: revoke tokens at member-remove time, OR check membership-still-valid in the auth hook for project-scoped tokens.
- **S-C3** [src/http.ts /v1/auth/login] **No per-username login throttle.** Only the global per-IP rate limit (600/min) applies. A botnet can brute-force any account at low IP cost. Fix: per-username sliding-window counter on failed logins; lockout after N failures with progressive backoff.
- **S-C4** [src/warm-store/index.ts:847-864] **`getEntry`'s `projectId === "*"` magic-string bypass.** Disables both tenant and project checks. No live caller passes it; one wrong refactor = full bypass. Fix: remove the bypass, replace with a typed `bypassScope?: true` option in a separate internal API.

## Security — High Findings

- **S-H1** SSE-MCP `/mcp/messages` trusts only `sessionId`; sessionId is logged at line 938 and lacks a bearer-rebind check.
- **S-H2** `engine.forget` filters DELETEs by `tenant_id = bearer's tenant` even on project rows. Cross-tenant project member's forget silently no-ops; function falsely returns `deleted: true`.
- **S-H3** Pino has no `redact` rules → Authorization headers, login passwords, mint plaintexts can land in logs.
- **S-H4** `sessionStorage` token + Swagger UI `'unsafe-inline'` style-src + CORS `origin: true` on same origin = post-XSS session theft path. Move to HttpOnly + SameSite cookie, tighten CSP, allow-list CORS.
- **S-H5** Sessions never GC'd; `expires_at` fixed at creation (not sliding).
- **S-H6** `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` survives in `process.env` for the process lifetime; visible via `docker inspect`. No complexity floor enforced.
- **S-H7** `addRelation` writes the bearer's `tenant_id` even on project-scoped writes; orphans cross-tenant relation rows on cleanup.
- **S-H8** `recent()` SQL builder uses a fixed `LIMIT $2` reference and string-concatenated WHERE clauses; `since` is unvalidated as ISO-8601; `ftsSearch` uses runtime regex column-name replacement.
- **S-H9** Zero audit logging of admin actions (tenant create/delete, user create/delete/role change, token mint/revoke).

## Performance — Critical

- **P-C1** [src/engine/index.ts decay()] **Decay loop fires one UPDATE per cold candidate.** With 1M warm rows, that's 1M round-trips per loop iteration. Single SQL UPDATE-FROM joining `memory_access` would be 500–1000× faster.

## Performance — High

- **P-H1 / P-H2** `engine.search` does N+1 round-trips per fused result (one `getEntry` per id, plus per-result `bumpHits`). Batch to `WHERE id = ANY($1)` and a single batched UPSERT.
- **P-H3** Metrics polling drives `SELECT COUNT(*) FROM memory_entries WHERE cold=…` every 5s per dashboard tab. With 10M+ rows, slow. Add in-process gauges OR a `(tenant_id, cold)` composite index.
- **P-H4** `linkVectorNeighbors` issues 3 sequential `addEdge` Cypher calls per `remember()`. Single `UNWIND` MERGE collapses to one round-trip.
- **P-H5** Reaper ORDER BY `last_attempt_at` is unindexed.
- **P-H6** `pg.Pool` has no explicit `max` — under load, silent connection-pool exhaustion.
- **P-H7** WarmStore `initialize()` runs DDL every boot with AccessExclusive locks; serialises K8s rolling deploys. Wrap in `pg_advisory_xact_lock`.

## Critical Issues for Phase 3 Context

The most consequential findings cluster into **four themes**, all of which deserve fixes before Phase 3:

1. **Project-as-isolation contract is partially broken** (S-C1, S-C2, S-H2, S-H7, A1). The model is right; three implementation paths (forget DELETE, addRelation INSERT, removeProjectMember cleanup) still filter by tenant_id, and one path (cold-store prefix scan) is exploitable as a destructive admin action. **These are the headline blockers.**

2. **Authentication hardening is incomplete** (S-C3, S-H3, S-H4, S-H5, S-H6). Bcrypt is fine, but rate limiting, session sliding/GC, log redaction, and CSP/CORS need work. Login is currently brute-forceable.

3. **Hot-path query patterns are N+1** (P-C1, P-H1, P-H3, P-H4). Decay loop + search + metrics polling all do the right thing once-per-row when SQL/Cypher could do it once-total. Easy 100×–1000× wins on the perf side.

4. **Operational visibility gaps** (S-H9 audit log, P-M3 metrics-Map leak, S-H1 sessionId log smuggling). No one would notice if any of (1) or (2) were exploited.

These findings should inform the Phase 3 testing review — most have no test coverage today. Specifically:

- Cross-tenant member can / cannot delete project entries (S-H2) — no test currently asserts the actual behaviour.
- Removed-member tokens stop working (S-C2) — no test.
- Tenant id `p_x` collision (S-C1) — no test (and probably no validation in the create-tenant route either).
- Login brute-force / per-username rate limit (S-C3) — no test.
- Decay loop scaling (P-C1) — no perf test.
- Audit log of admin actions (S-H9) — no audit log to test.
