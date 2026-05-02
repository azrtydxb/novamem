> **Note (2026-05):** this change documents the *original* admin dashboard arc (metrics + tenant CRUD).
> Subsequent work shipped on top without a corresponding OpenSpec change: dashboard sessions,
> projects (sub-brains), Swagger UI, audit log. For the current architecture see
> [ARCHITECTURE.md](../../../ARCHITECTURE.md) and [SECURITY.md](../../../SECURITY.md).

## Why

Operators running novamem in `tenant` mode currently must manage tenants and tokens via raw `curl` calls and have no visibility into how the tiered memory system is actually performing — there is no way to see whether warm/cold tiers are healthy, how many queries are landing where, or whether decay/promotion is working as designed. A simple admin dashboard turns the existing admin API plus new operational metrics into something a human can actually use to run the service.

## What Changes

- Add a built-in admin web UI served by the server at `/admin` (single-page app, vanilla — no separate deploy target).
- Tenant management screens: list tenants, create tenants, mint tokens, list tokens (hashes/metadata), revoke tokens. Plaintext tokens shown once at creation.
- Health screen: liveness + per-dependency status (Postgres, Qdrant, FalkorDB, embeddings provider) with last-checked timestamps.
- Memory-layer telemetry screen with per-tenant + global breakdowns:
  - Counts: warm entries, cold entries, graph edges, orphans.
  - Activity: queries/sec, remembers/sec, hits per tier (warm vs cold vs graph), zero-hit query rate.
  - Lifecycle: promotions (cold→warm), demotions (warm→cold), forgets, decay-loop runs and last-run timestamp.
- Add `GET /v1/admin/metrics` endpoint returning the structured metrics consumed by the dashboard (also useful for external scraping).
- Instrument the engine + stores to record the counters above (in-process, exposed via the metrics endpoint).
- Authenticate the dashboard with the existing `NOVAMEM_ADMIN_TOKEN`; the UI prompts for it on first load and stores it in `sessionStorage`.

## Capabilities

### New Capabilities
- `admin-dashboard`: web UI for tenant/token management and operational visibility, served by the novamem server.
- `admin-metrics`: structured operational metrics (counters + gauges) for queries, hits per tier, promotions, demotions, decay runs, and dependency health, exposed via `GET /v1/admin/metrics`.

### Modified Capabilities
<!-- None — there are no existing specs in openspec/specs/ to modify. -->

## Impact

- **Code**: `packages/server/src/http.ts` (new routes, static asset serving), new `packages/server/src/admin/` directory for UI assets and metrics collector, instrumentation hooks in `packages/server/src/engine/`, `cold-store.ts`, `warm-store/`, `graph-store.ts`.
- **APIs**: new `GET /v1/admin/metrics`; new `GET /admin` (and asset routes) for the UI. No breaking changes to existing endpoints.
- **Auth**: dashboard reuses `NOVAMEM_ADMIN_TOKEN`. In `auth.mode != tenant`, the dashboard still works for health/metrics but tenant management screens are disabled (admin token required, same constraint as today's admin API).
- **Dependencies**: add `@fastify/static` for serving the SPA bundle. UI is built with plain HTML + a small framework (Preact or vanilla) to avoid a heavyweight frontend toolchain in this server package.
- **Docs**: README gets a "Admin dashboard" section pointing at `/admin`.
