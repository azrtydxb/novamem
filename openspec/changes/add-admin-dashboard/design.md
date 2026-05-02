## Context

novamem already exposes admin endpoints for tenant/token CRUD and a `/v1/stats` endpoint for per-namespace counts. What is missing is (a) a human UI on top of those APIs, and (b) operational metrics that let an operator see how the tiered memory system is *behaving* — not just how many rows exist. The server is a single Fastify app shipped as a Docker image; the dashboard must work out-of-the-box with no extra services.

The codebase is a pnpm monorepo under `packages/`. The server is in `packages/server` and is the only place that needs to change. The engine (`engine/index.ts`), warm/cold/graph stores already exist and are the natural instrumentation points.

## Goals / Non-Goals

**Goals:**
- A working `/admin` UI accessible from any browser, gated by `NOVAMEM_ADMIN_TOKEN`.
- Tenant + token CRUD parity with existing admin API (no new admin operations).
- Metrics that answer: *is each layer healthy, how much traffic is each layer absorbing, are entries flowing through warm→cold→forget as designed?*
- Zero new infrastructure. Metrics live in-process; no Prometheus dependency required (but the `/v1/admin/metrics` shape should be Prometheus-compatible-friendly so a future exporter is trivial).
- Single Docker image still produces a working dashboard — UI assets are bundled into the npm package.

**Non-Goals:**
- Multi-user dashboard auth, RBAC, audit logs. The admin token is the only gate.
- Historical time-series storage. Metrics are point-in-time + short rolling windows held in memory; restarts reset them.
- Editing memories from the UI. Read-only against memory data; tenants/tokens are the only mutable surface.
- A separate frontend deploy or build pipeline outside the server package.

## Decisions

### D1 — Mount the dashboard inside the server, not a separate package
Serve the SPA from Fastify under `/admin/*` using `@fastify/static`. Bundle the built assets into `packages/server/dist/admin/`.

**Why:** keeps the "single docker image" promise and avoids CORS, separate auth, and a second deploy. The dashboard is small enough that the bundle cost is negligible.

**Alternatives considered:** a separate `packages/admin-ui` published to a CDN — rejected for operational complexity. A standalone Next.js app — rejected as overkill.

### D2 — Use Preact + htm, no build-time JSX, no bundler
Serve a single `index.html` that imports Preact + `htm` from a vendored ESM bundle in the package. All UI code is hand-written ES modules, no TypeScript compilation step for the UI.

**Why:** the server package already ships ESM. Adding Vite/webpack/esbuild for ~10 screens worth of UI is disproportionate. Preact + htm gives us components without a JSX toolchain.

**Alternatives considered:** plain vanilla DOM (rejected — too verbose for forms/lists); React + Vite (rejected — build chain heavy); HTMX (rejected — adds server-side template churn for marginal gain).

### D3 — Metrics live in a single in-process collector module
New file `packages/server/src/admin/metrics.ts` exports a singleton `MetricsCollector` with typed `inc()` / `observe()` / `snapshot()` methods. Engine/store code calls it at known points (search end, remember, decay loop, promotion, demotion). Output is a structured JSON blob via `GET /v1/admin/metrics`.

**Why:** dependency-free, fits the existing "no extra infra" stance, easy to unit-test. Counters are plain numbers; rates are computed from a small ring buffer of last-N events per metric for "queries/sec last 60s".

**Alternatives considered:** prom-client — rejected because it forces a Prometheus text format response and ties the API shape to Prometheus conventions. We can add a Prom endpoint later if asked.

### D4 — Hits-per-tier is recorded in the engine, not the stores
The engine knows which result came from which signal (warm FTS, cold vector, graph). After the fused result is built, the engine increments `hits_warm`, `hits_cold`, `hits_graph` based on which signals contributed to the top-k. Zero-hit queries increment `queries_zero_hit`.

**Why:** stores don't know whether their result was kept after fusion. The engine is the one place that has the final picture.

### D5 — Promotions and demotions are counted at the call site
The decay loop and the existing cold→warm promotion path each increment a counter when they actually move an entry. Instrumentation is one line per call site; no AOP / interceptors.

### D6 — Auth: dashboard uses `NOVAMEM_ADMIN_TOKEN` via session-stored bearer
On first load, `/admin` shows a token prompt. Token is stored in `sessionStorage` and sent as `Authorization: Bearer <admin-token>` on every fetch. No cookies, no CSRF surface.

**Why:** identical security posture to the existing admin API. No new credential type to manage.

**Trade-off:** sessionStorage means the token is reachable from any XSS in the dashboard. The dashboard ships no third-party JS and the asset routes set strict CSP headers (`default-src 'self'`).

### D7 — Tenant management screens degrade gracefully when `auth.mode != tenant`
The metrics + health screens always work (they only need the admin token). Tenant CRUD screens render a banner ("server is not in tenant mode") and disable mutation forms when `GET /v1/admin/tenants` returns 400/501.

## Risks / Trade-offs

- **In-memory metrics reset on restart** → acceptable; this is an *operational* dashboard, not a SLO system. Document it.
- **Bundling vendored Preact ESM** → mitigated by pinning a specific version + SHA in a vendor manifest, never auto-updating.
- **Admin token in sessionStorage** → mitigated by strict CSP + no third-party scripts. An attacker with XSS in the dashboard already has admin access via the same fetch calls.
- **Counter drift across many decay loops** → counters are unbounded `number` (53-bit safe integer). At 1 query/ms, overflow is ~285 years away. No reset strategy needed.
- **`@fastify/static` route conflicts with `/v1/admin/*` API** → mitigated by mounting under `/admin/` (no version prefix) so the namespaces are disjoint.

## Migration Plan

1. Land metrics collector + endpoint behind a flag `NOVAMEM_ADMIN_DASHBOARD=1`. Existing API behaviour unchanged.
2. Land UI assets and `/admin` mount behind the same flag. Verify in `docker compose up` that the dashboard renders against a real cluster.
3. Flip the flag default to "on" once the metrics endpoint is stable. The flag remains as an opt-out for embedded users who don't want the UI surface.
4. Rollback: setting `NOVAMEM_ADMIN_DASHBOARD=0` returns 404 from `/admin/*` and `/v1/admin/metrics`. No DB migrations are involved, so rollback is purely config.

## Open Questions

- Do we want per-namespace metrics, or only per-tenant? (Lean: per-tenant only — namespaces are user-defined and unbounded.)
- Should the dashboard expose a "trigger decay now" button, or is the existing `POST /v1/decay` sufficient and out of scope here? (Lean: include the button — it's a one-line UI add and answers a real operator need.)
