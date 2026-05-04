# API reference

The HTTP API is fully described by an **OpenAPI 3.0 spec** generated from the running server. The generated artefact lives next to this file:

- [`openapi.json`](openapi.json) — committed, regenerated via `pnpm docs:api`

## Live Swagger UI

Any running novamem server serves the spec under `/api-docs` (Swagger UI with "Try it out" enabled) and the raw JSON at `/openapi.json`:

- Local: <http://localhost:7778/api-docs>
- Raw spec: <http://localhost:7778/openapi.json>

The dashboard sidebar links straight to it.

## Regenerating the static spec

The committed `openapi.json` is generated, not handwritten. To refresh it after changing routes:

```bash
pnpm docs:api
```

Behind the scenes that builds `@azrtydxb/novamem-server` and runs `packages/server/scripts/gen-openapi.mjs`, which imports `openapiSpec()` from `packages/server/src/openapi.ts` and writes JSON to `docs/api/openapi.json`.

## Surface at a glance

The spec groups operations by tag:

| Tag | Routes |
|---|---|
| `memory` | `POST /v1/search` · `POST /v1/remember` · `PUT /v1/memories/:id` · `POST /v1/recent` · `POST /v1/neighbors` · `POST /v1/forget` · `GET /v1/stats` |
| `lifecycle` | `POST /v1/decay` · `POST /v1/dream-cycle` |
| `auth` | `POST /v1/auth/rotate-token` (`/api/auth/*` is owned by Better Auth, not described here) |
| `self-service` | `/v1/me/*` — same shape as `/v1/*`, gated by the dashboard session |
| `projects` | `/v1/me/projects[/:id[/members[/:userId]]]` · `/v1/me/active-project` |
| `tokens` | `/v1/me/tokens[/:hash]` |
| `metrics` | `/v1/me/metrics` · `/v1/me/metrics/history` |
| `admin` | `/v1/admin/audit-log` · `/v1/admin/metrics` · `/v1/admin/metrics/prom` |
| `liveness` | `GET /health` |

Everything except `/health` and `/openapi.json` requires authentication. Two security schemes are defined:

- `BearerToken` — `Authorization: Bearer nm_…` (user bearer; carries every right the owning user has)
- `SessionCookie` — Better Auth's HttpOnly cookie (dashboard sessions; also accepted as `Authorization: Bearer <session>`)

The data-plane routes (`/v1/search`, `/v1/remember`, …) accept either credential. Admin routes additionally require `role: admin` on the resolved user.

## Generating a typed client

The OpenAPI spec is the source of truth — anything that consumes it works:

```bash
# OpenAPI Generator (TypeScript, Go, Rust, …)
npx @openapitools/openapi-generator-cli generate \
  -i docs/api/openapi.json -g typescript-fetch -o ./client

# orval (TanStack Query / Axios bindings)
npx orval --input docs/api/openapi.json --output ./client/api.ts
```

For TypeScript, the [`@azrtydxb/novamem`](../../packages/client) package is already a hand-written client with public types — usually preferable to a generated one.

## MCP vs HTTP

Every MCP tool maps to an HTTP route — they're the same engine behind the scenes. Reach for HTTP when:

- You're scripting against the server from a non-MCP runtime (CI job, cron, custom CLI)
- You need streaming (`/mcp/sse` is the only streaming transport — HTTP is request/response)
- You want fine-grained control over headers, retries, timeouts

Reach for MCP when:

- An AI agent is the caller — MCP is the protocol every modern agent host already speaks
- You want the server to ship behaviour rules to the client via the protocol's `instructions` field

## See also

- [Skill bundle](../../skills/novamem/SKILL.md) — same surface as the MCP tools, packaged for Agent Skills clients
- [TypeScript client](../../packages/client/README.md) — `NovamemClient` with method signatures matching the HTTP API
- [Architecture](../architecture.md) — what each route does internally
