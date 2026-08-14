---
title: Local development
---

# Local development

Hack on novamem with a hot-reloading dev loop.

## Prereqs

- **Node ≥ 20.19** (22 LTS recommended) and **pnpm 9+**: `corepack enable && corepack prepare pnpm@9 --activate`
- **Docker** (for the datastores)
- A few GB of free RAM for the local embedder

## Clone + install

```bash
git clone https://github.com/azrtydxb/novamem.git
cd novamem
pnpm install
```

## Bring up datastores

The cleanest path is to run only the datastores via Compose, and run novamem from source:

```bash
# Start just postgres + qdrant
docker compose up -d postgres qdrant

# Set env vars for the source-run server
export NOVAMEM_WARM_URL=postgres://novamem:novamem@localhost:5432/novamem
export NOVAMEM_COLD_URL=http://localhost:6333
export NOVAMEM_COOKIE_SECRET=$(openssl rand -hex 32)
export NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 12)
export NOVAMEM_BOOTSTRAP_ADMIN_EMAIL=dev@local
```

## Run the server (tsx + hot reload)

```bash
pnpm --filter @azrtydxb/novamem-server dev
# Listens on :7778
# Edit src/*.ts → restarts automatically
```

## Run the dashboard (Vite dev)

In another terminal:

```bash
pnpm --filter @azrtydxb/novamem-admin-ui dev
# Listens on :5173 with hot module reload
# Proxies /v1, /api/auth, /health to localhost:7778
```

Open [http://localhost:5173/admin](http://localhost:5173/admin).

## Run tests

```bash
# All tests
pnpm test

# A specific package
pnpm --filter @azrtydxb/novamem-server test

# A specific file (vitest watch)
pnpm --filter @azrtydxb/novamem-server test -- --watch engine.test.ts
```

## Type-check

```bash
pnpm typecheck
# or per-package
pnpm --filter @azrtydxb/novamem-server typecheck
```

## Build everything

```bash
pnpm build
```

Outputs:

- `go/novamem-server` — the compiled server binary
- `packages/admin-ui/dist/` — the SPA bundle, synced into `go/internal/httpapi/admin-ui/` by `go/scripts/sync-admin-ui.sh` and embedded in the binary
- `packages/client/dist/`, `packages/mcp/dist/`, `packages/init/dist/` — published packages

## Build the docker image locally

```bash
docker build -f go/Dockerfile -t novamem:dev .
docker run --rm -p 7778:7778 \
  -e NOVAMEM_WARM_URL=postgres://novamem:novamem@host.docker.internal:5432/novamem \
  -e NOVAMEM_COLD_URL=http://host.docker.internal:6333 \
  -e NOVAMEM_COOKIE_SECRET=dev \
  -e NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=dev \
  novamem:dev
```

For cross-arch (build on mac arm64 → run on amd64 cluster):

```bash
docker buildx build --platform linux/amd64 -t novamem:dev --load .
```

## Useful commands

```bash
# Full server test suite
pnpm --filter @azrtydxb/novamem-server test

# Lint (server)
pnpm --filter @azrtydxb/novamem-server lint

# Format check
pnpm format:check

# Regenerate OpenAPI doc
pnpm --filter @azrtydxb/novamem-server openapi:gen

# Migrate the dev database (drizzle-kit)
pnpm --filter @azrtydxb/novamem-server migrate
```

## See also

- [Project layout](/contribute/layout) — what lives where
- [Testing](/contribute/testing) — vitest patterns, fakes, integration tests
- [Filing bugs](/contribute/bugs)
