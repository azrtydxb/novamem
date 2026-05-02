## 1. Metrics collector + endpoint

- [x] 1.1 Add `packages/server/src/admin/metrics.ts` exporting a `MetricsCollector` class with `inc(name, n=1)`, `recordQuery(hits)`, `setGauge(name, value)`, `markDecayRun()`, and `snapshot()` returning `{ counters, gauges, rates }`.
- [x] 1.2 Implement a 60-second ring buffer for `queries_per_sec_60s` and `remembers_per_sec_60s` (timestamps in a circular array, dropped lazily on snapshot).
- [x] 1.3 Wire a singleton instance into `engine/index.ts` and the stores via constructor injection (no module-global state).
- [x] 1.4 Instrument `engine.search`: increment `queries_total`, increment per-tier hit counters based on which signals contributed to the fused top-k, increment `queries_zero_hit` when the result list is empty.
- [x] 1.5 Instrument `engine.remember`: increment `remembers_total`.
- [x] 1.6 Instrument `engine.forget`: increment `forgets_total`.
- [x] 1.7 Instrument the cold→warm promotion path (currently in `engine/`): increment `promotions_total` once per promoted entry.
- [x] 1.8 Instrument the decay loop (`main.ts` / `engine/`): increment `decay_runs_total` once per loop tick, `demotions_total` per demoted entry, and update `last_decay_run_iso`.
- [x] 1.9 Instrument orphan reaper to increment `orphans_reaped_total`.
- [x] 1.10 Implement the gauges: query warm/cold/graph stores at snapshot time; tolerate FalkorDB unreachability by returning `null` for `graph_edges`.
- [x] 1.11 Add `GET /v1/admin/metrics` route in `http.ts`, gated by the existing admin-token check, returning the snapshot. Respect `NOVAMEM_ADMIN_DASHBOARD=0` → 404.
- [x] 1.12 Unit tests for `MetricsCollector` (counter monotonicity, ring buffer correctness, rate computation, reset on construction).
- [x] 1.13 Integration tests in `http.test.ts` for `/v1/admin/metrics`: 401 without token, 200 with token, counters reflect engine activity, 404 when dashboard flag is off.

## 2. Dashboard SPA assets

- [x] 2.1 Create `packages/server/src/admin/ui/` with `index.html`, `assets/app.js`, `assets/app.css`.
- [x] 2.2 Vendor Preact + htm as ESM modules under `assets/vendor/` and pin their versions in a `VENDOR.md` manifest with SHA-256 hashes.
- [x] 2.3 Build the token-prompt component: full-screen prompt on first load, stores token in `sessionStorage` under key `novamem_admin_token`, calls `/v1/admin/metrics` once to validate before continuing.
- [x] 2.4 Build the layout shell with three tabs: "Health", "Metrics", "Tenants".
- [x] 2.5 Build the Health screen: poll `GET /health` every 5s, render a card per dependency with green/yellow/red indicator and last-checked timestamp.
- [x] 2.6 Build the Metrics screen: poll `GET /v1/admin/metrics` every 5s, render counter cards (queries, remembers, forgets, promotions, demotions, decay runs, orphans reaped), gauges (warm/cold/graph entries, orphans pending), rate cards (q/s, r/s last 60s), tier-hit ratio bar, last decay run timestamp.
- [x] 2.7 Add a "Run decay now" button on the Metrics screen that calls `POST /v1/decay` and refreshes; surface success/failure inline.
- [x] 2.8 Build the Tenants screen: list tenants from `GET /v1/admin/tenants`, create-tenant form, expandable per-tenant token list (`GET /v1/admin/tenants/:id/tokens`), mint-token action with one-time plaintext display, revoke action with confirmation.
- [x] 2.9 Detect non-tenant mode by handling 400/501 from `GET /v1/admin/tenants` and rendering the "tenant management disabled" banner with disabled controls.
- [x] 2.10 Style with a single hand-written CSS file — no Tailwind, no component library; aim for legibility on a single laptop screen.

## 3. Server wiring

- [x] 3.1 Add `@fastify/static` to `packages/server/package.json` dependencies.
- [x] 3.2 In `http.ts`, register `@fastify/static` rooted at the bundled `admin/ui/` directory under URL prefix `/admin/`, with `Content-Security-Policy: default-src 'self'` headers on all responses.
- [x] 3.3 Ensure `GET /admin` and `GET /admin/` both return `index.html` (SPA fallback for the root).
- [x] 3.4 Gate the static mount and the metrics route on `NOVAMEM_ADMIN_DASHBOARD !== "0"`.
- [x] 3.5 Update the package build (`tsup` / `tsc` config) to copy `src/admin/ui/**` into `dist/admin/ui/**` so the published npm package and Docker image both include the assets.
- [x] 3.6 Update `Dockerfile` if needed to ensure assets land in the runtime image.

## 4. Config

- [x] 4.1 Add `adminDashboard: boolean` to `config.ts` with env var `NOVAMEM_ADMIN_DASHBOARD` (default `true`).
- [x] 4.2 Update `config.test.ts` to cover the new flag (default on, `0` disables, anything else enables).
- [x] 4.3 Plumb the flag through `main.ts` into `buildServer`.

## 5. Tests

- [x] 5.1 In `http.test.ts`, add tests that `GET /admin` returns 200 + HTML when enabled and 404 when disabled.
- [x] 5.2 Add a test that `/admin/assets/app.js` is served with the strict CSP header.
- [x] 5.3 Add an end-to-end test using the existing live-DB harness: perform a search + remember + decay run, then assert that `/v1/admin/metrics` reflects the activity.
- [x] 5.4 Add a regression test that confirms `/v1/admin/metrics` reports `null` for `graph_edges` when FalkorDB is unreachable.

## 6. Docs

- [x] 6.1 Add an "Admin dashboard" section to `README.md` describing how to reach `/admin`, what the screens do, and the `NOVAMEM_ADMIN_DASHBOARD` flag.
- [x] 6.2 Document `GET /v1/admin/metrics` in the same place the existing admin endpoints are documented (README + `/openapi.json` if present).
- [x] 6.3 Note the in-memory / non-persistent nature of the metrics in the README so operators don't expect long-term history.
