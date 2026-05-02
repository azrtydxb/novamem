# Phase 4: Best Practices & Standards

Per-phase outputs in `.full-review/04a-best-practices.md` (20 findings) and `.full-review/04b-cicd.md` (19 findings).

## Summary

| Source | Critical | High | Medium | Low |
|---|---|---|---|---|
| Framework / Language | 0 | 4 | 6 | 7+3 info |
| CI/CD & DevOps | 0 | 8 | 7 | 4 |
| **Total** | **0** | **12** | **13** | **14** |

## Framework / Language — Top Findings

- **B-H1** No `setErrorHandler` on Fastify. Every handler does `Body.parse(req.body)` and a `ZodError` thrown inside falls through to Fastify's default → 500 response. Should be 400 with field-level errors.
- **B-H2** No data-fetching library — six React pages each reimplement `useEffect` + `setInterval` polling + manual loading/error state. Cache invalidation, race-on-unmount, refetch-on-focus all hand-rolled inconsistently. **TanStack Query** is the obvious fix.
- **B-H3** `recharts` (~40% of the 600KB bundle) ships eagerly in the main chunk → SignIn page that doesn't use charts pays the full bundle cost. Lazy-load `MetricsPage` via `React.lazy`.
- **B-H4** Zod request schemas live only in the server; `@azrty/novamem` client re-types every shape by hand. Drift inevitable. Move shared shapes to a `@azrty/novamem-types` workspace package or export from server's tsconfig.
- **B-M1** 37 raw `pool.query` calls in warm-store vs 3 Drizzle calls. No drizzle-kit, no migrations folder, schema is hand-rolled idempotent DDL. Pick one — either go all-Drizzle with migrations, or commit to raw SQL and remove drizzle-kit deps.
- **B-M2** `packages/server/src/mcp.ts` and `packages/mcp/src/index.ts` register the same tool list twice (~90% duplicated). Export the schema definitions from the server package.
- **B-INFO-1** Outdated deps surveyed: React 18→19, Vite 6→8, Tailwind 3→4, recharts 2→3, Zod 3→4, Drizzle 0.36→0.45, bcryptjs (now archived) → consider argon2 or `bcrypt` native, lucide-react 0.468→1.14.
- **B-INFO-2** Confirmed positives: tsconfig.base.json has `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + NodeNext + isolatedModules; almost no `any` casts; ESM `.js` import suffixes throughout; StrictMode enabled.

## CI/CD & DevOps — Top Findings

- **O-H1** A pre-existing `.github/workflows/ci.yml` exists but is minimal: `typecheck/build/test` on push/PR. **No lint, no integration tests, no `npm audit`, no container scan (Trivy/Grype), no release flow.**
- **O-H2** No supply-chain guardrails — no Dependabot/Renovate, no `npm audit` step, no secret scanning, no SBOM generation.
- **O-H3** No release automation. `client` and `mcp` packages have versions (`0.1.0-preview.0`) but no publish workflow, no changelog generation, no version-bump script.
- **O-H4** Container runs as **root** inside the runtime stage — no `USER node` directive. Container-escape blast radius higher than necessary.
- **O-H5** Runtime image ships test files, `tsx`, `vitest`, `@types/*`, and `src/*.ts`. `Dockerfile:21-22` copies full `packages/` and `node_modules`. Should ship `dist/` + production deps only. Likely halves image size.
- **O-H6** Bootstrap admin password sits in `process.env` for the process lifetime → visible via `docker inspect`. Code never `delete process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` after seeding.
- **O-H7** All three backing stores exposed on host ports in `docker-compose.yaml` (5432, 6333, 6379) with no comment that production deployments must NOT do this.
- **O-H8** Schema is forward-only — DDL is `ALTER ... ADD COLUMN IF NOT EXISTS`; no `DROP COLUMN` ever, no migration tooling, no rollback story for schema changes.
- **O-M1** No `HEALTHCHECK` directive in Dockerfile; `/health` exists but the container declares no liveness probe.
- **O-M2** No `.env.example` at repo root; no `.dockerignore` either.
- **O-M3** `sseTransports` Map at `http.ts:921` is never iterated on shutdown — in-flight SSE-MCP connections aren't drained.
- **O-M4** No Prometheus exposition format / OpenTelemetry hooks; no log shipping integration. The dashboard `/v1/admin/metrics` is the only first-class observability surface.
- **O-L1** No `SECURITY.md`, no `CODEOWNERS`. (Already flagged in docs phase as D3.)
- **O-L2** Server `package.json` is implicitly `private: false` despite being a runtime application not a publishable library.

## Convergent themes from this phase

1. **The CI gate is too weak.** A typecheck + test workflow exists but doesn't enforce lint, audit, container scanning, or integration tests. Several Phase 1–3 findings would have been caught by stricter CI.
2. **The runtime image is hardened on the inside, soft on the outside.** Strict tsconfig, careful auth code — but the container runs as root, ships test code, has no health probe, and has no SBOM.
3. **The frontend is stuck in 2022.** No data-fetching library, no code splitting, no React Query, ships everything eagerly. Multiple high-leverage fixes available.
4. **Schema management is half-baked.** Drizzle is configured but only used to read; raw SQL is used to write. No migrations folder. Schema changes are forward-only and hand-rolled.
