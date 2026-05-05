---
title: Environment reference
---

# Environment variable reference

Every novamem-server config knob lives in env vars. The schema is enforced at startup by [`packages/server/src/config.ts`](https://github.com/azrtydxb/novamem/blob/main/packages/server/src/config.ts) — boot fails fast if anything required is missing.

## Required for production

| Variable | Required when | What it does |
|---|---|---|
| `POSTGRES_PASSWORD` | always | The Postgres password. Compose substitutes it into `NOVAMEM_WARM_URL` and the `postgres` container's `POSTGRES_PASSWORD`. |
| `NOVAMEM_COOKIE_SECRET` | `NOVAMEM_AUTH_MODE != none` | Signs HttpOnly session cookies. Generate with `openssl rand -hex 32`. Must be stable across restarts; rotating invalidates every active session. |
| `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` | first-boot only | Seeds an initial admin user via Better Auth on the very first start (when no users exist). Auto-scrubbed from `process.env` after seeding. |

## Server transport

| Variable | Default | Description |
|---|---|---|
| `NOVAMEM_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to confine to localhost. |
| `NOVAMEM_PORT` | `7778` | HTTP port. Both REST and `/mcp/sse` are served here. |
| `NOVAMEM_BASE_URL` | `http://localhost:7778` | Public origin used for the dashboard's HTML head + Better Auth callback URLs. Update when you put novamem behind a reverse proxy. |
| `NOVAMEM_RATE_LIMIT_PER_MINUTE` | `600` | Per-IP cap. SSE bypasses it (one long-lived connection); see `MAX_SESSIONS_PER_USER` for SSE limits. |
| `NOVAMEM_CORS_ORIGINS` | `` | Comma-separated list of allowed origins. Empty disables cross-origin browser access. |
| `NOVAMEM_INSECURE_COOKIES` | `0` | When `1`, drops the `Secure` flag on session cookies. **Dev only.** Do not enable in production. |

## Authentication

| Variable | Default | Description |
|---|---|---|
| `NOVAMEM_AUTH_MODE` | `user` | One of `none`, `bearer`, `tenant`, `user`. `user` is the modern default — Better Auth sessions for the dashboard, per-user `nm_…` bearers for MCP. `none` is dev-only — every request becomes the public tenant. |
| `NOVAMEM_AUTH_TOKEN` | — | Required when `mode = bearer`. Single shared bearer token; useful for one-process deploys where you want a static credential. |
| `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` | `admin@example.com` | Email for the bootstrap admin. |
| `NOVAMEM_ADMIN_DASHBOARD` | `1` | Master switch. Set `0` to 404 the entire `/admin/*` and `/v1/admin/metrics` surface. |

## Datastores

| Variable | Default | Description |
|---|---|---|
| `NOVAMEM_WARM_URL` | `postgres://novamem:CHANGE_ME@localhost:5432/novamem` | Postgres connection string for the warm tier + Better Auth tables + audit log. |
| `NOVAMEM_PG_POOL_MAX` | `20` | Pool size cap. Bound below your Postgres `max_connections`. |
| `NOVAMEM_COLD_URL` | `http://localhost:6333` | Qdrant REST endpoint for the cold (vector) tier. |
| `NOVAMEM_COLD_VECTOR_SIZE` | `384` | Embedding dimension. Must match `NOVAMEM_EMBEDDINGS_DIM`. |
| `NOVAMEM_GRAPH_ENABLED` | `true` | When `false`, the engine skips graph writes + reads and emits `degraded:true` on every search. |
| `NOVAMEM_GRAPH_URL` | `redis://localhost:6379` | FalkorDB endpoint (Redis protocol). |

## Embeddings

| Variable | Default | Description |
|---|---|---|
| `NOVAMEM_EMBEDDINGS_PROVIDER` | `local-transformers` | `local-transformers` runs `@xenova/transformers` in-process (no API key, ~1 GB RAM on first call). `openai-compatible` calls an external HTTP endpoint. |
| `NOVAMEM_EMBEDDINGS_ENDPOINT` | — | Required when provider is `openai-compatible`. e.g. `https://api.openai.com/v1`. |
| `NOVAMEM_EMBEDDINGS_MODEL` | — | e.g. `text-embedding-3-small` (OpenAI) or `nomic-embed-text` (Ollama). |
| `NOVAMEM_EMBEDDINGS_API_KEY` | — | API key for the external endpoint. |
| `NOVAMEM_EMBEDDINGS_DIM` | `384` | Vector dimension produced by the model. Must match Qdrant collection size. |

## Memory engine

| Variable | Default | Description |
|---|---|---|
| `NOVAMEM_DECAY_INTERVAL_MS` | `21600000` (6 h) | How often the synaptic-decay sweep runs. Set `0` to disable. |
| `NOVAMEM_DECAY_DAYS` | `7` | Base half-life. Effective lifespan grows with hits: `effectiveDays = NOVAMEM_DECAY_DAYS · log₂(hits + 1)`. |
| `NOVAMEM_SSE_KEEPALIVE_MS` | `25000` | SSE `: ping` cadence. Must be shorter than the client's HTTP body-read timeout (undici defaults to 5 min). |

## Logging & telemetry

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | Pino log level: `trace` · `debug` · `info` · `warn` · `error`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | When set, the server enables OpenTelemetry traces for HTTP + engine spans, exported via OTLP/gRPC. |
| `OTEL_SERVICE_NAME` | `novamem` | Resource attribute for emitted spans. |

## See also

- [`/.env.example`](https://github.com/azrtydxb/novamem/blob/main/.env.example) — annotated template
- [Docker Compose install](/install/docker-compose) — how Compose feeds these vars
- [Kubernetes install](/install/kubernetes) — how the manifest maps these into ConfigMap + Secret
