# Phase 1: Code Quality & Architecture Review

Per-phase outputs in `.full-review/01a-code-quality.md` (25 findings) and `.full-review/01b-architecture.md` (23 findings).

## Summary

| Source | Critical | High | Medium | Low |
|---|---|---|---|---|
| Code Quality | 2 | 8 | 9 | 6 |
| Architecture | 3 | 8 | 8 | 4 |
| **Total** | **5** | **16** | **17** | **10** |

## Code Quality — Top Findings

- **C1** [src/auth.ts:14-17, src/http.ts:302-305] Session-TTL comment says "refreshed on every request" but `expiresAt` is fixed at creation; **no GC sweep ever deletes expired sessions** — `sessions` table grows unbounded.
- **C2** [src/http.ts:776-794, src/warm-store/index.ts:694-700] `removeProjectMember` does NOT revoke that user's project-scoped tokens. A removed collaborator's `nm_…` tokens keep working until they happen to be in the same tenant during a tenant delete. **Privilege not actually revoked.**
- **H1** [src/http.ts] 974-LOC mega-function with security-critical auth hook nested 6 levels deep.
- **H2** [src/warm-store/index.ts:797-836] `ftsSearch` does `scopeClause.replace(/(project_id|tenant_id)/g, "f.$1")` — runtime regex string-replace on column references. Fragile under future edits.
- **H3** Project-vs-tenant scoping rule is hand-restated four times (warm/cold/graph/engine). Recommended `Scope` value object.
- **H4** [src/engine/index.ts:303-326] Engine bypasses warm-store with raw SQL for `recent()`. Couples engine to the SQL layer.
- **H5** [src/test-fakes.ts] 822-LOC fake parses production SQL via substring matching; throws on any unmatched query.
- **H6** [src/graph-store.ts:113-135] `removeAllForTenant` / `removeAllForProject` swallow ALL errors silently → engine reports `graphCleared: true` even when nothing was cleared.
- **H7** [src/http.ts:946-952] SSE `/mcp/messages` does not verify the request bearer's tenant matches the captured session tenant. **Cross-session message smuggling possible.**
- **H8** [src/http.ts:204-205, 225-232] `cors: { origin: true }` plus Swagger UI's `'unsafe-inline'` style-src on the same origin widens XSS-to-session-theft surface.
- **M4** [src/warm-store/index.ts] DDL `ALTER TABLE memory_entries ADD COLUMN` runs **before** `CREATE TABLE memory_entries` (lines 108 vs 117). Crashes on a fresh DB unless one ALTER runs after the CREATE. (Architecture review separately confirmed this — A9.)
- **M9** [src/http.ts:204] Pino logger has no `redact` for `req.headers.authorization` — bearer plaintext can land in logs.

## Architecture — Top Findings

- **A1** [src/warm-store/index.ts:393-395 in `getEntry`] Magic-string `projectId === "*"` bypass disables the access boundary. Public API tripwire.
- **A2** [src/cold-store.ts:49 + 110-117] **Tenant ID `p` or `p_*` would make `deleteAllForTenant`'s prefix scan match every project-scoped collection across all tenants.** Silent data-loss vector. No validation refuses such tenant ids.
- **A3 / A11** [src/engine/index.ts forget(); src/warm-store/addRelation()] On project-scoped writes, deletes filter by `tenant_id` even though shared projects span tenants. Cross-tenant member's forget silently no-ops; relation rows accumulate orphaned.
- **A8** SSE-MCP cleanup happens only on `close`; an `error` event leaks the transport entry forever.
- **A9** Same DDL-ordering bug as M4 — ALTER before CREATE on the very first table created in `initialize()`.
- **A14** Per-tenant metric counters are scoped by the *bearer's* tenant, not the entry's owner tenant. Cross-tenant project queries get charged to the wrong tenant.

## Critical Issues for Phase 2 Context

The Phase 2 (security + performance) review should specifically investigate:

1. **Authorization on project-scoped operations**: with cross-tenant members allowed, every memory route must use `project_id` as the access boundary, not `tenant_id`. Verify forget / neighbors / search / remember all do the right thing AND that the bearer→project binding cannot be bypassed (token mint enforces membership; runtime auth-hook trusts the token).

2. **Tenant ID validation**: A2 (cold collection prefix collision) is exploitable if an admin can name a tenant `p` or `p_anything`. Verify the tenant slug regex (`^[a-z0-9][a-z0-9_-]*$`) does NOT prevent this — it allows `p_foo`. **The cold store's `deleteAllForTenant` walks `novamem_<tenant>_*` and would match `novamem_p_<projectId>_<ns>` collections.**

3. **Session lifetime + storage growth**: C1 (sessions table grows unbounded) is also a perf concern over time. Confirm whether `last_seen_at` updating on every request is also an unintended hotspot.

4. **Token / password handling in logs**: M9 (Pino redaction) — verify nothing accidentally serializes plaintext tokens or passwords to logs (login body has password, mint response has plaintext token).

5. **Cross-session SSE-MCP message smuggling**: H7 — does session resumption verify the bearer matches?

6. **CORS+CSP attack surface**: H8 — wildcard CORS plus `unsafe-inline` in Swagger UI's CSP. Could a CSRF or post-auth XSS chain steal session tokens from sessionStorage?

7. **Bcrypt cost factor**: 10 rounds — fine today but worth noting.

8. **Performance**: warm-store DDL runs every startup (idempotent CREATE/ALTER). Acceptable on fresh DB; on a populated one those ALTERs are no-ops but Postgres still acquires the lock — should be brief but worth flagging in perf review.

9. **N+1 patterns**: search → loop → getEntry per result. Engine code has multiple per-result lookups. Worth checking if a single `WHERE id IN (...)` would be cleaner and faster.

10. **Bundle size**: admin-ui ~600KB unminified — is recharts the heavy hitter? Could it be code-split?
