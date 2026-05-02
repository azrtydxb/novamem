## ADDED Requirements

### Requirement: Dashboard is served at `/admin`
The novamem server SHALL serve a single-page admin dashboard at the path `/admin`, returning `index.html` for `GET /admin` and `GET /admin/` and serving static assets under `/admin/assets/*`.

#### Scenario: Dashboard root loads
- **WHEN** an unauthenticated browser requests `GET /admin`
- **THEN** the server responds `200 OK` with `Content-Type: text/html` and the HTML body contains a token-entry form

#### Scenario: Dashboard assets are served
- **WHEN** the dashboard HTML requests `GET /admin/assets/app.js`
- **THEN** the server responds `200 OK` with `Content-Type: application/javascript` and a strict `Content-Security-Policy: default-src 'self'` header

### Requirement: Dashboard is gated by the admin token
All dashboard data fetches SHALL be authenticated by the `NOVAMEM_ADMIN_TOKEN` sent as `Authorization: Bearer <token>`. The HTML shell itself MAY load without the token.

#### Scenario: Missing admin token blocks data
- **WHEN** the dashboard calls `GET /v1/admin/metrics` without an `Authorization` header
- **THEN** the server responds `401 Unauthorized` and the dashboard shows a token-entry prompt

#### Scenario: Wrong admin token blocks data
- **WHEN** the dashboard calls `GET /v1/admin/metrics` with `Authorization: Bearer wrong`
- **THEN** the server responds `401 Unauthorized`

### Requirement: Dashboard provides tenant management
The dashboard SHALL provide screens to list tenants, create a tenant, list a tenant's tokens, mint a new token for a tenant, and revoke a token, by calling the existing `/v1/admin/tenants*` endpoints.

#### Scenario: Operator creates a tenant
- **WHEN** an authenticated operator submits the create-tenant form with `id=acme` and `name=Acme Corp`
- **THEN** the dashboard sends `POST /v1/admin/tenants` and on success refreshes the tenants list to include `acme`

#### Scenario: Operator mints a token
- **WHEN** an authenticated operator clicks "Mint token" for tenant `acme`
- **THEN** the dashboard sends `POST /v1/admin/tenants/acme/tokens` and displays the plaintext token exactly once with a "Copy" affordance and a warning that it cannot be shown again

#### Scenario: Operator revokes a token
- **WHEN** an authenticated operator clicks "Revoke" on a token row and confirms
- **THEN** the dashboard sends `POST /v1/admin/tokens/revoke` with the token hash and removes the row on success

### Requirement: Dashboard shows component health
The dashboard SHALL display a health screen showing liveness and per-dependency status for Postgres, Qdrant, FalkorDB, and the embeddings provider, using the existing `GET /health` endpoint.

#### Scenario: All dependencies up
- **WHEN** `GET /health` returns `{ ok: true, deps: { postgres: "ok", qdrant: "ok", falkor: "ok", embeddings: "ok" } }`
- **THEN** the dashboard renders each dependency with a green status indicator

#### Scenario: A dependency is down
- **WHEN** `GET /health` reports `falkor: "unreachable"`
- **THEN** the dashboard renders FalkorDB with a red status indicator and shows the reported message

### Requirement: Dashboard shows memory-layer metrics
The dashboard SHALL display a metrics screen with: warm/cold/graph entry counts, query and remember rates over the last 60 seconds, hits per tier (warm/cold/graph), zero-hit query rate, total promotions, total demotions, total forgets, and the last decay-loop run timestamp. Data SHALL come from `GET /v1/admin/metrics`.

#### Scenario: Metrics render
- **WHEN** an authenticated operator opens the metrics screen
- **THEN** the dashboard fetches `GET /v1/admin/metrics` and renders all counters, gauges, and the rolling rates in clearly labelled cards

#### Scenario: Metrics auto-refresh
- **WHEN** the metrics screen has been open for 5 seconds
- **THEN** the dashboard re-fetches `GET /v1/admin/metrics` and updates the displayed values without a full page reload

### Requirement: Dashboard degrades when `auth.mode != tenant`
When the server is not in `tenant` mode, the dashboard SHALL show a banner explaining that tenant management is unavailable and SHALL disable tenant/token mutation forms while keeping the health and metrics screens fully functional.

#### Scenario: Bearer mode hides tenant mutations
- **WHEN** the server is configured with `NOVAMEM_AUTH_MODE=bearer` and the operator opens the tenants screen
- **THEN** the dashboard renders a banner "Server is not in tenant mode — tenant management disabled" and the create/mint/revoke buttons are disabled

### Requirement: Dashboard mount is configurable
The dashboard mount SHALL be controlled by the `NOVAMEM_ADMIN_DASHBOARD` environment variable. When unset or `1`, the dashboard is served. When `0`, `/admin/*` returns `404` and the metrics endpoint is also disabled.

#### Scenario: Dashboard disabled
- **WHEN** the server starts with `NOVAMEM_ADMIN_DASHBOARD=0` and a client requests `GET /admin`
- **THEN** the server responds `404 Not Found`

#### Scenario: Dashboard enabled by default
- **WHEN** the server starts without setting `NOVAMEM_ADMIN_DASHBOARD` and a client requests `GET /admin`
- **THEN** the server responds `200 OK` with the dashboard HTML
