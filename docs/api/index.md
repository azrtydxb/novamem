---
title: API reference
---

# API reference

novamem exposes one HTTP surface that every transport (REST, MCP, dashboard SPA) drives. The OpenAPI document is generated from the Go server's own route table — it is the source of truth, and a CI drift gate fails if the committed copy falls behind it.

## Browse it

Two surfaces, one document:

- **[Interactive reference](./reference.md)** — this site, rendered from the
  spec on `main`.
- **`GET /api-docs` on any deployment** — the same renderer, embedded in the
  binary and pointed at that server's own `/openapi.json`. It documents the
  server in front of you rather than whatever shipped last, and it works with
  no internet: the bundle is vendored, not fetched from a CDN. Public, like
  the spec itself.

## OpenAPI spec

Machine-readable: [`docs/api/openapi.json`](https://github.com/azrtydxb/novamem/blob/main/docs/api/openapi.json) on GitHub, or `/openapi.json` on a live server.

## Regenerating the static spec

`openapi.json` is the generated artefact, owned by the Go server. To refresh it after adding a route or editing a schema:

```bash
cd go && go run ./cmd/gen-openapi
```

The generator walks the route table and schema definitions in `go/internal/httpapi/openapi.go` and writes JSON to `docs/api/openapi.json`. CI re-runs it and fails on a dirty tree.

## Routes by purpose

| Section                           | Routes                                                                                                            | Auth           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| **[Authentication](./auth.md)**   | `/api/auth/*`, `POST /v1/me/tokens`                                                                               | mixed          |
| **[Data plane](./data-plane.md)** | `/v1/search`, `/v1/remember`, `/v1/capture`, `/v1/recent`, `/v1/neighbors`, `/v1/forget`, `PUT /v1/memories/{id}` | user API token |
| **[Admin & users](./admin.md)**   | `/v1/admin/*`, `/api/auth/admin/*`                                                                                | session admin  |
| **[MCP tools](./mcp-tools.md)**   | `/mcp/sse`, `/mcp/messages`                                                                                       | tenant bearer  |

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

## Generating a typed client

The OpenAPI spec is the source of truth — anything that consumes it works:

```bash
# OpenAPI Generator (TypeScript, Go, Rust, …)
npx @openapitools/openapi-generator-cli generate \
  -i docs/api/openapi.json -g typescript-fetch -o ./client

# orval (TanStack Query / Axios bindings)
npx orval --input docs/api/openapi.json --output ./client/api.ts
```

For Go, [`clients/go`](https://github.com/azrtydxb/novamem/tree/main/clients/go) is a hand-written client with public types — usually preferable to a generated one.

## MCP vs HTTP

Most MCP tools map to the same engine operations as HTTP routes. Reach for HTTP when:

- You're scripting against the server from a non-MCP runtime (CI job, cron, custom CLI)
- You need streaming — `/mcp/sse` is the only streaming transport; HTTP is request/response
- You want fine-grained control over headers, retries, timeouts

Reach for MCP when:

- An AI agent is the caller — MCP is the protocol every modern agent host already speaks
- You want the server to ship behaviour rules to the client via the protocol's `instructions` field
