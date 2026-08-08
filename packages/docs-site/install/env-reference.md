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
| `NOVAMEM_CORS_ORIGINS` | `` | Comma-separated list of allowed origins. Empty disables cross-origin browser access. `*` reflects any origin **and disables credentialed CORS** — reflect-any plus credentials would let any site read authenticated responses, so cookie/session auth from a browser requires an explicit allowlist. |
| `NOVAMEM_INSECURE_COOKIES` | `0` | When truthy (`1`/`true`/`yes`/`on`), drops the `Secure` flag on session cookies. **Dev only.** `docker-compose.yaml` defaults it to `1` so localhost-over-HTTP works; `docker-compose.prod.yaml` pins it back to `0`. Leaving it on behind a TLS-terminating proxy means the browser will also send the session cookie over plain HTTP to the same host. |

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
| `NOVAMEM_COLD_TIMEOUT_MS` | `15000` | Per-request Qdrant timeout. Bounds a stalled vector tier so it degrades instead of hanging every search. |
| `NOVAMEM_COLD_VECTOR_SIZE` | `384` | Embedding dimension. Must match `NOVAMEM_EMBEDDINGS_DIM`. |
| `NOVAMEM_GRAPH_ENABLED` | `true` | When `false`, the engine skips graph writes + reads and emits `degraded:true` on every search. |
| `NOVAMEM_GRAPH_URL` | `redis://localhost:6379` | FalkorDB endpoint (Redis protocol). |
| `NOVAMEM_GRAPH_TIMEOUT_MS` | `10000` | Per-query FalkorDB timeout. A failed or timed-out query marks the graph unhealthy and starts a backoff reconnect. |

## Embeddings

| Variable | Default | Description |
|---|---|---|
| `NOVAMEM_EMBEDDINGS_PROVIDER` | `local-transformers` | `local-transformers` runs `@xenova/transformers` in-process (no API key, ~1 GB RAM on first call). `openai-compatible` calls an external HTTP endpoint. |
| `NOVAMEM_EMBEDDINGS_ENDPOINT` | — | Required when provider is `openai-compatible`. e.g. `https://api.openai.com/v1`. |
| `NOVAMEM_EMBEDDINGS_MODEL` | — | e.g. `text-embedding-3-small` (OpenAI) or `nomic-embed-text` (Ollama). |
| `NOVAMEM_EMBEDDINGS_API_KEY` | — | API key for the external endpoint. |
| `NOVAMEM_EMBEDDINGS_DIM` | `384` | Vector dimension produced by the model. Must match Qdrant collection size. |
| `NOVAMEM_EMBEDDINGS_TIMEOUT_MS` | `30000` | Per-request timeout for remote embedders. The query is embedded *before* the per-tier degradation fan-out, so an unbounded hang here stalls every search. |
| `NOVAMEM_EMBEDDINGS_QUERY_PREFIX` | inferred | Prefix applied when embedding a **search query**. Left unset, it is inferred from the model id (`e5-*` → `query: `, `bge-*-en` → `Represent this sentence for searching relevant passages: `). |
| `NOVAMEM_EMBEDDINGS_DOCUMENT_PREFIX` | inferred | Prefix applied when embedding **stored content** (`e5-*` → `passage: `). |

::: warning Changing the embedding model
On start-up the server records the embedding model id that produced the stored vectors. If it changes between runs, it logs a loud error: vectors from two models live in incompatible spaces, so existing memories silently stop being findable. A dimension change at least errors on write; a same-dimension swap (384 → 384, the common case) fails completely silently. Re-embed after a deliberate swap — all content lives in Postgres, so re-embedding is total and safe.
:::

::: tip Asymmetric retrieval models
The e5 and bge families are trained with *different* prefixes on the query and document sides and lose a large chunk of their accuracy when both sides are embedded identically. novamem now embeds each side separately and infers the right prefixes from the model id, so these models work correctly out of the box.

Note that changing `NOVAMEM_EMBEDDINGS_MODEL` on an existing deployment invalidates every stored vector — the old and new models produce incompatible embedding spaces. If the dimension is unchanged this fails *silently*: old memories simply stop being findable. Re-embed after a model swap.
:::

## Memory engine

| Variable | Default | Description |
|---|---|---|
| `NOVAMEM_DECAY_INTERVAL_MS` | `21600000` (6 h) | How often the synaptic-decay sweep runs. Set `0` to disable. |
| `NOVAMEM_DECAY_DAYS` | `7` | Base half-life. Effective lifespan grows with hits: `effectiveDays = NOVAMEM_DECAY_DAYS · log₂(hits + 1)`. |
| `NOVAMEM_SSE_KEEPALIVE_MS` | `25000` | SSE `: ping` cadence. Must be shorter than the client's HTTP body-read timeout (undici defaults to 5 min). |
| `NOVAMEM_SEARCH_MIN_VECTOR_SCORE` | `0.25` | Absolute cosine floor for candidates proposed *only* by the vector tier. Cosine search always returns a nearest neighbour, so without a floor an unrelated store still yields confident-looking hits. Candidates corroborated by a keyword or graph signal are exempt. Set `0` to disable. |
| `NOVAMEM_MAX_CONTENT_CHARS` | `4000` | Reject writes longer than this. Past the embedding model's context window the tail is silently dropped by the tokenizer, leaving a memory that keyword search finds and vector search cannot. Set `0` to disable. |
| `NOVAMEM_PERSONAL_TERMS` | — | Comma-separated deployment-specific vocabulary (operator name, product names, project slugs) that the worthiness scorer treats as high-relevance. |

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
