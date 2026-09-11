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
│   ├── docs-site/     @azrtydxb/novamem-docs-site — VitePress config for this site
│   └── benchmarks/                                — retrieval eval fixtures
├── bench/                      — Python retrieval benchmarks
├── docs/                       — every documentation page; this site is built from it
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

The VitePress configuration for this site — nav, sidebar, theme, the
mermaid plugin — plus `public/`. It builds `docs/` into `site/docs/`, so
the Pages workflow picks up the landing page and the docs as one
artifact.

## What lives in `docs/` vs `packages/docs-site/`

`docs/` holds every page. `packages/docs-site/` holds only the VitePress
configuration (`.vitepress/config.mts`, whose `srcDir` points at
`../../docs`) and the static assets — no readable content at all, and
`pnpm docs:smoke` fails if a page reappears there.

Editing a doc in the repo IS editing the site. A handful of internal
working documents — the migration specs under `superpowers/`, the parity
audits, the benchmark write-ups — stay in `docs/` but are kept out of the
published navigation via `srcExclude`.

## How to find things

| I want to…                 | Look in                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| Add a new memory operation | `go/internal/engine/` + `go/internal/mcp/tooldefs.json`                           |
| Change the dashboard       | `packages/admin-ui/src/pages/`                                                    |
| Tweak the install CLI      | `go/internal/initcli/`                                                            |
| Update a doc               | `docs/<section>/`                                                                 |
| Add an env var             | `.env.example` + `go/internal/config/config.go` + `docs/install/env-reference.md` |
| Fix a CI failure           | `.github/workflows/`                                                              |
| Cut a release              | a `vX.Y.Z` tag — CI builds the image and the CLI binaries                         |
