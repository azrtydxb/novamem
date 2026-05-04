# Manual install

Run novamem and its three datastores directly on a host. Use this if you already operate Postgres / Qdrant / FalkorDB and don't want another container layer, or if you're hacking on the server itself.

For most deployments [Docker Compose](docker.md) is simpler. For multi-node use [Kubernetes](kubernetes.md).

## Prerequisites

- **Node.js ≥ 20** (22 LTS recommended) and **pnpm 9+** — `corepack enable && corepack prepare pnpm@9 --activate`
- **Postgres ≥ 16** — used for warm storage, audit log, Better Auth tables
- **Qdrant ≥ 1.12** — vector store for the cold tier
- **FalkorDB ≥ 6** (Redis protocol on 6379) — graph store; optional, server degrades gracefully when unreachable
- **\~1 GB RAM free** for the local embedding model on first call (downloads `all-MiniLM-L6-v2` from Hugging Face)

## Datastores

Quick smoke test — point each at the same host:

```bash
# Postgres
createdb novamem
createuser novamem -P  # set a password

# Qdrant — bind 6333 (REST) and 6334 (gRPC)
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant:v1.12.4

# FalkorDB
docker run -d --name falkordb -p 6379:6379 falkordb/falkordb:edge
```

novamem creates tables and collections on first start (idempotent DDL, idempotent collection creation). No migration tool needed.

## Build and run novamem

```bash
git clone https://github.com/azrtydxb/novamem.git
cd novamem
pnpm install
pnpm -r build

cp .env.example .env
# Edit .env — at minimum:
#   NOVAMEM_WARM_URL=postgres://novamem:...@localhost:5432/novamem
#   NOVAMEM_COLD_URL=http://localhost:6333
#   NOVAMEM_GRAPH_URL=redis://localhost:6379
#   NOVAMEM_COOKIE_SECRET=$(openssl rand -hex 32)
#   NOVAMEM_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
#   NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=...   # min 8 chars

set -a; source .env; set +a
node packages/server/dist/main.js
```

Or run under a process supervisor:

```bash
# systemd unit (excerpt)
[Service]
EnvironmentFile=/etc/novamem.env
ExecStart=/usr/bin/node /opt/novamem/packages/server/dist/main.js
Restart=always
User=novamem
```

The server listens on `NOVAMEM_HOST:NOVAMEM_PORT` (default `0.0.0.0:7778`).

## First-run bootstrap

When `NOVAMEM_AUTH_MODE=user` and no admin user exists, novamem seeds one from `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` + `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD`, then scrubs the password from `process.env` so it doesn't surface via `/proc/<pid>/environ`. Sign in at `/admin`.

## Configuration

Full env reference: [.env.example](../../.env.example). The fields you'll touch most:

| Var | Default | Notes |
|---|---|---|
| `NOVAMEM_PORT` | `7778` | HTTP + MCP-SSE listen port |
| `NOVAMEM_BASE_URL` | `http://localhost:7778` | Public origin; **must** match the browser's `Origin` header for Better Auth's trusted-origin check |
| `NOVAMEM_AUTH_MODE` | `user` | `user` / `bearer` / `none`; only `user` enforces per-user isolation |
| `NOVAMEM_COOKIE_SECRET` | _(none)_ | 32+ hex chars; **must** be set in production |
| `NOVAMEM_INSECURE_COOKIES` | `0` | `1` to allow non-Secure cookies (plain-HTTP dev only) |
| `NOVAMEM_EMBEDDINGS_PROVIDER` | `local-transformers` | Or `openai-compatible` with `_ENDPOINT` + `_MODEL` + `_API_KEY` |
| `NOVAMEM_DECAY_INTERVAL_MS` | `21600000` (6h) | Decay loop + dream cycle cadence |
| `NOVAMEM_GRAPH_ENABLED` | `true` | Set `false` to skip FalkorDB (search degrades to keyword + vector) |
| `NOVAMEM_PG_POOL_MAX` | `20` | Per-process Postgres pool size |

## Verify

```bash
curl http://localhost:7778/health
# { "ok": true, "deps": { "postgres": "ok", "qdrant": "ok", "falkordb": "ok" } }
```

Then [mint a bearer](../getting-started.md#3-mint-a-bearer-token) and connect a client.

## Upgrades

Schema migrations are forward-only (`ALTER ... ADD COLUMN IF NOT EXISTS`). Back up Postgres before upgrading novamem in place; there is no rollback path beyond `pg_restore`.

```bash
pg_dump -U novamem -d novamem -Fc > novamem-warm.dump
git pull && pnpm install && pnpm -r build
# restart
```

## Troubleshooting

- `403 Invalid origin` on sign-in → `NOVAMEM_BASE_URL` doesn't match the browser's Origin. Set it to the exact public URL and restart.
- `connect ECONNREFUSED ...:6379` → FalkorDB unreachable. Either start it or set `NOVAMEM_GRAPH_ENABLED=false` to skip the graph signal.
- Local embeddings hang on first call → the model is downloading; subsequent calls are fast.
- Cookies not sticking on `http://` → set `NOVAMEM_INSECURE_COOKIES=1` for dev, or terminate TLS in front for prod.
