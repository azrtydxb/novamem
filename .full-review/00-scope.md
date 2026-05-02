# Review Scope

## Target

Whole-repo comprehensive review of the **novamem** monorepo. Tiered memory service for AI agents (Postgres + Qdrant + FalkorDB) with HTTP/JSON + MCP transports, multi-tenant + project (sub-brain) isolation, and an embedded React dashboard.

## Files

Four workspace packages (~13.4k LOC of TS/TSX, plus React/admin-ui):

- **`packages/server/`** — Fastify HTTP + MCP transports, engine, warm/cold/graph stores, auth (bcrypt sessions), RBAC, projects, metrics collector, OpenAPI document.
  - `src/http.ts` (974 LOC) — all routes + auth hook + RBAC + project enforcement
  - `src/engine/index.ts` (~470 LOC) — search/remember/forget/decay/promote/reap orchestration
  - `src/warm-store/index.ts` (978 LOC) — Postgres driver, idempotent DDL, project + user + session methods
  - `src/warm-store/schema.ts` (212 LOC) — Drizzle table definitions
  - `src/cold-store.ts` — Qdrant client + per-tenant + per-project collections
  - `src/graph-store.ts` — FalkorDB client + tenant + project filters
  - `src/auth.ts` — bcrypt password hashing + bootstrap admin
  - `src/admin/metrics.ts` — per-tenant + global counters/gauges/rates
  - `src/openapi.ts` (~510 LOC) — hand-written OpenAPI 3.0 document
  - `src/mcp.ts` — local MCP server (stdio + SSE)
  - `src/main.ts` — service entry / wiring / decay loop
  - `src/types.ts`, `src/config.ts`, `src/embeddings.ts`, `test-fakes.ts`
  - Tests: `http.test.ts` (65), `engine.test.ts` (32), `mcp.test.ts` (8), `config.test.ts`, `metrics.test.ts`, `embeddings.test.ts`, integration suite

- **`packages/admin-ui/`** — Vite + React 18 + TS + Tailwind dashboard (bundled into the server image).
  - `src/App.tsx`, `src/main.tsx`
  - `src/components/` — AppShell, Modal, Toast, Card, Button, Input, Badge, StatCard
  - `src/pages/` — SignIn, HealthPage, MetricsPage, TenantsPage, UsersPage, MyTokensPage, ProjectsPage
  - `src/lib/` — api, auth-context, utils
  - Vite config, Tailwind config, tsconfig

- **`packages/client/`** — typed HTTP client (`@azrty/novamem`), now covers data plane + auth/projects/tokens.

- **`packages/mcp/`** — remote MCP-stdio shim + `novamem-login` helper binary.

- **Infrastructure**: `Dockerfile` (multi-stage build), `docker-compose.yaml` (5 services), `pnpm-workspace.yaml`.

## Flags

- **Security Focus**: yes — deeper audit of auth flows, password storage, CSRF, CSP, token handling, project authorization
- **Performance Critical**: yes — deeper pass on DB query patterns, N+1, bundle size, render perf, gauge/metric overhead
- **Strict Mode**: yes — block at checkpoint 1 if any Critical findings exist
- **Framework**: auto-detected (Fastify 5.x server, React 18 + Vite 6 dashboard, Drizzle ORM + raw `pg`, Tailwind 3, Recharts)

## Review Phases

1. Code Quality & Architecture
2. Security & Performance
3. Testing & Documentation
4. Best Practices & Standards
5. Consolidated Report
