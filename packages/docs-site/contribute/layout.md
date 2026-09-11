---
title: Project layout
---

# Project layout

novamem is Go, with a pnpm workspace for the two JavaScript surfaces
(the dashboard SPA and this site). Top-level:

```
novamem/
├── go/                         — the server, the CLIs, the engine
├── clients/go/                 — standalone Go client module
├── conformance/                — the behavioural oracle, run against a live target
├── packages/
│   ├── admin-ui/      @azrtydxb/novamem-admin-ui  — React 19 dashboard
│   ├── docs-site/     @azrtydxb/novamem-docs-site — VitePress (this site)
│   └── benchmarks/                                — retrieval eval fixtures
├── bench/                      — Python retrieval benchmarks
├── docs/                       — markdown docs (see below)
├── deploy/k8s/                 — Kubernetes manifests
├── site/                       — landing-page index.html + Pages output target
├── skills/                     — Agent Skills bundle
├── integrations/               — drop-in CLAUDE.md / commands for AI hosts
├── .github/workflows/          — CI, Pages, release binaries
├── docker-compose.yaml         — single-host stack
├── go/Dockerfile               — multi-arch server image
└── pnpm-workspace.yaml
```

## go/

The server itself — a single static Go binary that embeds the admin SPA,
the migrations and the OpenAPI document.

```
cmd/novamem-server/      — bootstrap: load config, migrate, serve
cmd/gen-openapi/         — writes docs/api/openapi.json from the route table
internal/
├── config/              — env schema, validated at startup
├── httpapi/             — routing, auth, CORS, rate limiting, /v1 + /api/auth
│   ├── openapi.go       — the OpenAPI source of truth
│   └── admin-ui/        — the embedded dashboard build
├── engine/              — search, remember, neighbors, decay, dream, facts
├── warmstore/           — Postgres layer
│   └── migrations/      — embedded SQL + drizzle-format journal
├── coldstore/           — pgvector and Qdrant backends
├── mcp/                 — MCP server: 21 tools over Streamable HTTP + SSE
└── auth/                — Better Auth-compatible hashing, cookies, JWKS
```

The TypeScript server this replaced (`packages/server`) was removed once
the Go server became the novamem-bench default and the conformance suite
was green against it there. The TypeScript client, the stdio MCP shim and
the installer CLI followed it, superseded by `clients/go/`,
`go/cmd/novamem-mcp` and `go/cmd/novamem-init`, which ship as binaries
from GitHub Releases rather than npm. There is no fallback and no legacy
mode — the git history is the archive.

## packages/admin-ui

React 19 + Vite + Tailwind v4. Pages live under `src/pages/`. Shared components in `src/components/`. Theme tokens (the Grid palette) in `src/index.css` via `@theme`.

The build outputs to `dist/`, then `go/scripts/sync-admin-ui.sh` copies it into `go/internal/httpapi/admin-ui/`, where `go:embed` bakes it into the binary. The server serves the SPA from there at `/admin/*`.

## go/cmd/novamem-init

The installer CLI. Host adapters under `go/internal/initcli/`, state
persisted at `$XDG_CONFIG_HOME/novamem/init.json`. Ships as a
per-platform binary from GitHub Releases.

## go/cmd/novamem-mcp

Tiny stdio ↔ HTTP MCP shim. Why it exists: some MCP hosts (Claude
Desktop, several editor extensions) still cannot speak remote MCP.

## clients/go/

A standalone Go module, so it can be imported without pulling in the
server. Its surface tracks `docs/api/openapi.json`, which the server
generates from its own route table.

## packages/docs-site

This site. VitePress + markdown. Builds into `site/docs/` so the Pages workflow picks both up.

## What lives in `docs/` vs `packages/docs-site/`

Two partially overlapping sets today, both hand-maintained, which is how
they drifted in both directions. They are being consolidated onto one
source — `docs/` canonical, this site built from it — tracked in
[#270](https://github.com/azrtydxb/novamem/issues/270).

## How to find things

| I want to…                 | Look in                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Add a new memory operation | `go/internal/engine/` + `go/internal/mcp/tooldefs.json`                                         |
| Change the dashboard       | `packages/admin-ui/src/pages/`                                                                  |
| Tweak the install CLI      | `go/internal/initcli/`                                                                          |
| Update a doc               | `packages/docs-site/<section>/`                                                                 |
| Add an env var             | `.env.example` + `go/internal/config/config.go` + `packages/docs-site/install/env-reference.md` |
| Fix a CI failure           | `.github/workflows/`                                                                            |
| Cut a release              | a `vX.Y.Z` tag — CI builds the image and the CLI binaries                                       |
