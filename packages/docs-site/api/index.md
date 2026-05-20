---
title: API reference
---

# API reference

novamem exposes one HTTP surface that every transport (REST, MCP, dashboard SPA) drives. The OpenAPI spec is generated from the same Zod schemas the server validates against at runtime — it's the source of truth.

## Live Swagger UI

Every running novamem deployment exposes interactive docs at:

```
GET  /api-docs
```

You can try every endpoint there with a real bearer token.

## OpenAPI spec

Machine-readable: [`docs/api/openapi.json`](https://github.com/azrtydxb/novamem/blob/main/docs/api/openapi.json) on GitHub, or `/openapi.json` on a live server.

## Routes by purpose

| Section | Routes | Auth |
|---|---|---|
| **[Authentication](/api/auth)** | `/api/auth/*`, `POST /v1/me/tokens` | mixed |
| **[Data plane](/api/data-plane)** | `/v1/search`, `/v1/remember`, `/v1/capture`, `/v1/recent`, `/v1/neighbors`, `/v1/forget`, `PUT /v1/memories/{id}` | user API token |
| **[Admin & users](/api/admin)** | `/v1/admin/*`, `/api/auth/admin/*` | session admin |
| **[MCP tools](/api/mcp-tools)** | `/mcp/sse`, `/mcp/messages` | tenant bearer |

## Per-user (cookie-auth) variants

The dashboard/session-scoped `/v1/me/*` routes are now self-service control-plane routes, not data-plane mirrors. They cover:

- `GET  /v1/me/today`
- `GET  /v1/me/onboarding`
- `GET  /v1/me/metrics` and `/v1/me/metrics/history`
- `GET  /v1/me/projects` (+ create/delete/members)
- `GET  /v1/me/active-project` (+ set/clear)
- `GET  /v1/me/tokens` (+ mint/revoke)

The data plane itself (`/v1/search`, `/v1/remember`, `/v1/capture`, `/v1/recent`, `/v1/neighbors`, `/v1/forget`, `PUT /v1/memories/{id}`) accepts both `nm_…` user bearers and valid Better Auth session credentials.

## Health

Always public, no auth:

```bash
curl https://novamem.example.com/health
```

Returns `{ "ok": true }` for public liveness. Dependency detail lives behind the admin deep-health and metrics routes.

## Versioning

`/v1/*` is stable. Breaking changes go to `/v2/*` with `/v1/*` kept alive for at least one major release. Schema migrations are forward-only — back up Postgres before upgrading in place.
