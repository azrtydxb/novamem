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

Machine-readable: [`docs/api/openapi.json`](https://github.com/azrtydxb/novamem/blob/main/docs/api/openapi.json) on GitHub, or `/api-docs/openapi.json` on a live server.

## Routes by purpose

| Section | Routes | Auth |
|---|---|---|
| **[Authentication](/api/auth)** | `/api/auth/*`, `POST /v1/me/tokens` | mixed |
| **[Data plane](/api/data-plane)** | `/v1/search`, `/v1/remember`, `/v1/recent`, `/v1/neighbors`, `/v1/forget`, `/v1/update` | tenant bearer |
| **[Admin & users](/api/admin)** | `/v1/admin/*`, `/api/auth/admin/*` | session admin |
| **[MCP tools](/api/mcp-tools)** | `/mcp/sse`, `/mcp/messages` | tenant bearer |

## Per-user (cookie-auth) variants

The dashboard SPA uses `/v1/me/*` mirrors instead of the bearer-only routes — same shapes, but auth is the HttpOnly cookie session:

- `POST /v1/me/search`
- `POST /v1/me/remember`
- `POST /v1/me/recent`
- `POST /v1/me/neighbors`
- `POST /v1/me/forget`
- `GET  /v1/me/today`
- `GET  /v1/me/onboarding`
- `GET  /v1/me/projects` (+ POST/DELETE/members)
- `GET  /v1/me/tokens` (+ POST/revoke)

## Health

Always public, no auth:

```bash
curl https://novamem.example.com/health
```

Returns the connectivity status of every dependency (Postgres, Qdrant, FalkorDB, embedder) so a load balancer or monitoring system can drive readiness from one endpoint.

## Versioning

`/v1/*` is stable. Breaking changes go to `/v2/*` with `/v1/*` kept alive for at least one major release. Schema migrations are forward-only — back up Postgres before upgrading in place.
