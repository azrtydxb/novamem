# Docker Compose install

Single-host all-in-one: novamem + Postgres + Qdrant + FalkorDB. The default for development and small deployments.

## Prerequisites

- Docker Engine 24+ with the Compose plugin (`docker compose version`)
- `\~2 GB RAM free`; the local embedder loads on first call

## Up in two commands

```bash
git clone https://github.com/azrtydxb/novamem.git
cd novamem

cp .env.example .env
echo "NOVAMEM_COOKIE_SECRET=$(openssl rand -hex 32)" >> .env
echo "NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 12)" >> .env

docker compose up -d
docker compose logs -f novamem  # watch the bootstrap
```

The compose file is the source of truth for ports + env wiring: [docker-compose.yaml](../../docker-compose.yaml).

| Service | Image | Host port |
|---|---|---|
| `novamem` | built from `./Dockerfile` | **7778** |
| `postgres` | `postgres:16-alpine` | 5432 |
| `qdrant` | `qdrant/qdrant:v1.12.4` | 6333 |
| `falkordb` | `falkordb/falkordb:edge` | 6379 |

Volumes (named): `novamem_pg`, `novamem_qdrant`, `novamem_falkor`.

## First-run bootstrap

When you bring the stack up with `NOVAMEM_AUTH_MODE=user` (the default) and no admin user exists, novamem seeds one from `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` + `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD`. The password is scrubbed from `process.env` after seeding so it doesn't surface via `docker inspect`.

Sign in at <http://localhost:7778/admin> with the email + password you set, then create your own non-admin user from the Users tab.

## Configuration

Override env via `.env` (compose reads it automatically) or by editing the `environment:` block in `docker-compose.yaml`. The full reference is [.env.example](../../.env.example). The fields you'll touch most for compose:

| Var | Compose default | Notes |
|---|---|---|
| `NOVAMEM_AUTH_MODE` | `user` | Only `user` enforces per-user isolation |
| `NOVAMEM_BASE_URL` | _(unset; uses `http://localhost:7778`)_ | **Must** match the URL the browser hits — set explicitly when running on a non-localhost host |
| `NOVAMEM_COOKIE_SECRET` | _(none)_ | Required in production |
| `NOVAMEM_INSECURE_COOKIES` | `1` | Default for compose so cookies work over plain `http://localhost`; **set to `0` in production** |
| `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` | `admin@example.com` | First admin email (only used on first start) |
| `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` | _(none)_ | Min 8 chars; required for first-run seeding |

## Persistence

The three named volumes hold all state. To reset:

```bash
docker compose down -v   # WARNING: drops all data
```

To back up:

```bash
docker compose exec postgres pg_dump -U novamem -d novamem -Fc > novamem-warm.dump
docker compose exec falkordb redis-cli BGSAVE
# Qdrant: take a snapshot per collection or tarball novamem_qdrant
```

## Updates

```bash
git pull
docker compose build novamem
docker compose up -d novamem
```

Schema migrations are forward-only — back up Postgres first.

## Going to production

The compose file is geared for development:

- Postgres has a default password (`novamem:novamem`) — change it
- `NOVAMEM_INSECURE_COOKIES=1` allows plain-HTTP cookies — flip to `0` and put a TLS-terminating reverse proxy (nginx, Caddy, Traefik) in front
- `NOVAMEM_BASE_URL` must match the public URL exactly (Better Auth checks Origin)
- Read [SECURITY.md](../../SECURITY.md) for the full hardening checklist

For multi-node use [Kubernetes](kubernetes.md) instead.

## Troubleshooting

- `novamem` container restarting → `docker compose logs novamem`. Most common: `NOVAMEM_COOKIE_SECRET` missing, or Postgres still warming up (compose waits on the healthcheck, but slow disks can race).
- `403 Invalid origin` on sign-in → set `NOVAMEM_BASE_URL` to the exact URL the browser uses and restart.
- Sign-in works but session doesn't stick → set `NOVAMEM_INSECURE_COOKIES=1` for dev, or terminate TLS in front for prod.
- First `memory_search` is slow → the local embedder is downloading the model on first call; subsequent calls are fast.

## Production deploy

`docker-compose.yaml` is intentionally dev-friendly: it publishes the
Postgres (5432), Qdrant (6333), and FalkorDB (6379) ports on the host so
you can poke at them from your laptop, and it pins FalkorDB to `:edge`.
Neither is appropriate for a real deployment.

The repo ships a `docker-compose.prod.yaml` override that:

- Removes the host port publishes for postgres, qdrant, and falkordb so
  the datastores stay on the internal compose network only.
- Removes the host port publish for the `novamem` app (port 7778) — the
  expectation is that a TLS-terminating reverse proxy on the same docker
  network forwards traffic to it.
- Pins `falkordb/falkordb` to a stable release tag instead of `:edge`.

Combine the two files when you bring the stack up:

```bash
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d
```

### Reverse proxy

Run your TLS terminator (Caddy, Traefik, nginx, …) on the same
`default` docker network created by compose, and point it at
`novamem:7778`. A minimal Caddy `Caddyfile`:

```
memory.example.com {
  reverse_proxy novamem:7778
}
```

Set `NOVAMEM_BASE_URL=https://memory.example.com` and
`NOVAMEM_INSECURE_COOKIES=0` in your `.env` so Better Auth stamps secure
cookies and validates the Origin header. For Traefik, attach the same
labels to the `novamem` service via a second override file, or extend
`docker-compose.prod.yaml` in your fork.

Datastores remain unreachable from outside the docker network. If you
need ad-hoc access for backups or debugging, run `docker compose exec`
into the relevant service rather than re-publishing ports.
