# Phase 3: Testing & Documentation Review

Per-phase outputs in `.full-review/03a-tests.md` (21 findings) and `.full-review/03b-docs.md` (15 findings).

## Summary

| Source | Critical | High | Medium | Low |
|---|---|---|---|---|
| Testing | 4 | 9 | 6 | 2 |
| Documentation | 2 | 4 | 6 | 3 |
| **Total** | **6** | **13** | **12** | **5** |

## Testing — Top Findings

- **T-C1** No regression test for `removeProjectMember` revoking project-scoped tokens (covers S-C2).
- **T-C2** No test for cross-tenant project member's `forget()` actually deleting (covers S-H2 — adversarial scenario today silently no-ops).
- **T-C3** No test for the `getEntry projectId === "*"` bypass (covers S-C4 — should be removed AND have a regression test).
- **T-C4** No test for tenant id `p_*` collision against project collection prefix (covers S-C1).
- **T-H1** Two packages with zero tests: `admin-ui` (`"test": "echo 'no tests' && exit 0"`, worse than `--passWithNoTests`) and `@azrty/novamem` client.
- **T-H2** Test fakes (test-fakes.ts:48-108) parse production SQL via substring matching — directly enabled multiple Phase 2 bugs to evade detection. Recommended: PGlite for warm-store integration tests + retire the SQL-shim approach.
- **T-H3** No `auth.test.ts`. Bcrypt edge cases (72-byte truncation, empty string, very long passwords) untested.
- **T-H6** No SSE bearer-rebind test (covers S-H1).
- **T-H8** No login-throttle test (covers S-C3 — feature also missing).
- **T-H9** No audit-log test (covers S-H9 — feature also missing).
- **T-M2** No decay-perf regression test — recommended an assertion of "≤50 queries for 10k cold candidates" to force the bulk-SQL refactor for P-C1.
- **T-INFRA** No CI workflow in `.github/workflows/`. No coverage reporting configured. Without these, the rest of the recommendations are undermined.

## Documentation — Top Findings

- **D1** README does not warn that tenant id `p_*` is dangerous (re S-C1).
- **D2** README does not document that `removeProjectMember` does NOT revoke that user's existing tokens (re S-C2 — operator gotcha).
- **D3** No `SECURITY.md`, no security-disclosure channel, no security-model section anywhere.
- **D4** Bootstrap admin password lifecycle (env var → `docker inspect`) not called out as a hardening concern.
- **D5 / D6** `@azrty/novamem` and `@azrty/novamem-mcp` ship to npm with no READMEs — registry pages will render blank.
- **D7** OpenSpec arc `add-admin-dashboard/` documents only the original admin dashboard; sessions, projects, and Swagger work shipped on top without a corresponding change record. Future readers may mistake the openspec for the current architecture.
- **D8** OpenAPI is structurally complete but has zero `examples:` blocks; single `{error: string}` schema with no per-route 4xx enumeration.
- **D9** Project-as-isolation invariant (the rule behind A1, A3, A11, S-H2, S-H7) is comment-noted in `getEntry` and `ftsSearch` only; ~6 other enforcement sites are silent. One docblock + a one-liner per site would prevent the next regression.
- **D10 / D11 / D12** No backup/restore/rollback/migration runbook, no `CHANGELOG.md`, no external-monitoring story (README points at Prometheus but `/v1/admin/metrics` is JSON, not exposition format).
- **D13 / D14** Project deletion's cross-tenant blast radius not loud enough; auth-mode table doesn't reference session bearers (`ns_…`).
- **D15** No `ARCHITECTURE.md`, no ADRs for the load-bearing decisions: per-tenant cold collections, project-as-isolation, bcrypt 10 rounds, in-process metrics resetting on restart.

## Cross-cutting Pattern

The same gap repeats: **the security-critical invariants of the system have neither test coverage nor documentation**. The project-as-isolation rule, the tenant-id name space, the bootstrap-password handling, the session GC story — all are written into code, none are written into tests or docs. A future contributor reading the codebase has no way to learn these rules other than tracing the call sites.
