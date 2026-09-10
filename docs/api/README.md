# API reference

The HTTP API is fully described by an **OpenAPI 3.0 spec**. The live spec is generated dynamically from Fastify route schemas (`schema` + Zod via `fastify-type-provider-zod`) and exposed by the server at `/openapi.json`. A static copy is committed next to this file for offline/reference use:

- [`openapi.json`](openapi.json) — committed, regenerated from the **Go** server's route table

## Live Swagger UI

Any running novamem server serves the spec under `/api-docs` (Swagger UI with "Try it out" enabled) and the raw JSON at `/openapi.json`:

- Local: <http://localhost:7778/api-docs>
- Raw spec: <http://localhost:7778/openapi.json>

The dashboard sidebar links straight to it.

## Regenerating the static spec

`openapi.json` is the generated artefact, owned by the Go server. To refresh it after adding a route or editing a schema:

```bash
cd go && go run ./cmd/gen-openapi
```

The generator walks the Go server's own route table and schema definitions in `go/internal/httpapi/openapi.go` and writes JSON to `docs/api/openapi.json`. A CI drift gate re-runs it and fails if the committed file changes.

## Surface at a glance

The spec groups operations by tag:

| Tag            | Routes                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory`       | `POST /v1/search` · `POST /v1/remember` · `PUT /v1/memories/:id` · `POST /v1/recent` · `POST /v1/neighbors` · `POST /v1/forget` · `GET /v1/stats`                                                                                     |
| `lifecycle`    | `POST /v1/decay` · `POST /v1/dream-cycle` · `POST /v1/reap-orphans`                                                                                                                                                                   |
| `auth`         | `POST /v1/auth/rotate-token` (`/api/auth/*` is owned by Better Auth, not described here)                                                                                                                                              |
| `self-service` | `/v1/me/*` — gated by the dashboard session (or an `nm_…` bearer). The data-plane `/v1/me/*` mirrors of `/v1/search`/`remember`/etc. were removed; `/v1/me/*` is now metrics, tokens, projects, active-project, onboarding, and today |
| `projects`     | `/v1/me/projects[/:id[/members[/:userId]]]` · `/v1/me/active-project`                                                                                                                                                                 |
| `tokens`       | `/v1/me/tokens` · `DELETE /v1/me/tokens/:hash`                                                                                                                                                                                        |
| `metrics`      | `/v1/me/metrics` · `/v1/me/metrics/history`                                                                                                                                                                                           |
| `admin`        | `/v1/admin/audit-log` · `/v1/admin/metrics` · `/v1/admin/metrics/prom` · `/v1/admin/health/deep`                                                                                                                                      |
| `liveness`     | `GET /health` (boolean-only)                                                                                                                                                                                                          |

Most routes require authentication, but several public surfaces bypass the app auth hook in addition to the OpenAPI doc itself: `/health`, `/openapi.json`, `/api-docs` (Swagger UI), the `/admin` SPA shell + assets, `/favicon.ico`, and Better Auth's public endpoints under `/api/auth/*` (sign-in, get-session, etc.). Two security schemes are defined:

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

Most MCP tools map to the same engine operations as HTTP routes. Project lifecycle, adoption, hygiene, and evaluation diagnostics also have HTTP or dashboard-adjacent surfaces where applicable. Reach for HTTP when:

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
