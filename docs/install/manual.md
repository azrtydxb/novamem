# Manual install

Run novamem and its two datastores directly on a host. Use this if you already operate Postgres / Qdrant and don't want another container layer, or if you're hacking on the server itself.

For most deployments [Docker Compose](./docker-compose.md) is simpler. For multi-node use [Kubernetes](kubernetes.md).

## Prerequisites

- **Node.js ≥ 20** (22 LTS recommended) and **pnpm 9+** — `corepack enable && corepack prepare pnpm@9 --activate`
- **Postgres ≥ 16** — used for warm storage, audit log, Better Auth tables
- **Qdrant ≥ 1.12** — vector store for the cold tier
- **\~1 GB RAM free** for the local embedding model on first call (downloads `all-MiniLM-L6-v2` from Hugging Face)

## Datastores

Quick smoke test — point each at the same host:

```bash
# Postgres
createdb novamem
createuser novamem -P  # set a password

# Qdrant — bind 6333 (REST) and 6334 (gRPC)
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant:v1.12.4

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
#   NOVAMEM_COOKIE_SECRET=$(openssl rand -hex 32)
#   NOVAMEM_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
#   NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=...   # min 8 chars

set -a; source .env; set +a
./novamem-server
```

Or run under a process supervisor:

```bash
# systemd unit (excerpt)
[Service]
EnvironmentFile=/etc/novamem.env
ExecStart=/opt/novamem/novamem-server
Restart=always
User=novamem
```

The server listens on `NOVAMEM_HOST:NOVAMEM_PORT` (default `0.0.0.0:7778`).

## First-run bootstrap

When `NOVAMEM_AUTH_MODE=user` and no admin user exists, novamem seeds one from `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` + `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD`, then scrubs the password from `process.env` so it doesn't surface via `/proc/<pid>/environ`. Sign in at `/admin`.

## Configuration

Every variable, with its real default and what goes wrong at the wrong
value, is in the [environment reference](./env-reference.md). That page is
generated from the loader, so it cannot disagree with the server the way a
second table here would — this one did, listing `local-transformers` as the
embeddings default when the Go server refuses to start on it.

The four you are most likely to set on a manual install:

| Var                     | Notes                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `NOVAMEM_WARM_URL`      | Required. Postgres DSN; the server will not start without it.                      |
| `NOVAMEM_COOKIE_SECRET` | Required unless `NOVAMEM_AUTH_MODE=none`. `openssl rand -hex 32`.                  |
| `NOVAMEM_BASE_URL`      | Public origin; **must** match the browser's `Origin` for the trusted-origin check. |
| `NOVAMEM_AUTH_MODE`     | `user` (default) / `bearer` / `none`; only `user` enforces per-user isolation.     |

## Verify

```bash
curl http://localhost:7778/health
# { "ok": true }
```

Public `/health` is boolean-only — no infrastructure detail leaks to unauthenticated callers. For a per-dependency snapshot, sign in as an admin first and re-use the session cookie:

```bash
# 1. Sign in (writes the session cookie to cookies.txt)
curl -sS -c cookies.txt -X POST http://localhost:7778/api/auth/sign-in/email \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"…"}'

# 2. Use the cookie for the admin-only deep-health endpoint
curl --cookie cookies.txt http://localhost:7778/v1/admin/health/deep
# { "ok": true, "deps": { "warm": "ok", "cold": "ok", "graph": "ok" } }
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
- Local embeddings hang on first call → the model is downloading; subsequent calls are fast.
- Cookies not sticking on `http://` → set `NOVAMEM_INSECURE_COOKIES=1` for dev, or terminate TLS in front for prod.
