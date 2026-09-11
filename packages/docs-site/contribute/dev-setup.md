---
title: Local development
---

# Local development

Hack on novamem: datastores in Compose, the server from source.

## Prereqs

- **Go ≥ 1.23** — the server, the CLIs and the conformance suite are all Go
- **Node ≥ 20.19** (22 LTS recommended) and **pnpm 9+**: `corepack enable && corepack prepare pnpm@9 --activate` — only the dashboard SPA and this docs site are JavaScript
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

## Run the server

```bash
cd go && go run ./cmd/novamem-server
# Listens on :7778
```

Go has no watcher built in; re-run the command after an edit, or put
your own (`air`, `watchexec`) in front of it.

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
# The server and everything under it
cd go && go test ./...

# One package
cd go && go test ./internal/engine/

# One test, with output
cd go && go test ./internal/engine/ -run TestHybrid -v
```

The dashboard SPA has its own suite: `pnpm test`.

## Type-check

```bash
cd go && go vet ./...   # Go
pnpm typecheck          # the SPA and this site
```

## Build everything

```bash
cd go && go build ./cmd/novamem-server
pnpm build
```

Outputs:

- `go/novamem-server` — the compiled server binary
- `packages/admin-ui/dist/` — the SPA bundle, synced into `go/internal/httpapi/admin-ui/` by `go/scripts/sync-admin-ui.sh` and embedded in the binary

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
docker buildx build --platform linux/amd64 -f go/Dockerfile -t novamem:dev --load .
```

## Useful commands

```bash
# Full server test suite
cd go && go test ./...

# Lint (the version CI pins)
cd go && go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 run ./...

# Regenerate the OpenAPI document — CI fails on a dirty tree afterwards
cd go && go run ./cmd/gen-openapi

# Conformance suite against a running target
pnpm conformance

# Documentation invariants
pnpm docs:smoke
```

There is no migrate command: the server embeds its migrations and
applies them on boot. See
[CONTRIBUTING.md](https://github.com/azrtydxb/novamem/blob/main/CONTRIBUTING.md#schema-changes)
for how to add one.

## See also

- [Project layout](./layout.md) — what lives where
- [Testing](./testing.md) — test layout, fakes, the conformance oracle
- [Filing bugs](./bugs.md)
