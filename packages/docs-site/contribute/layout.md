---
title: Project layout
---

# Project layout

novamem is a pnpm monorepo. Top-level:

```
novamem/
├── packages/
│   ├── server/        @azrtydxb/novamem-server   — the Fastify service
│   ├── client/        @azrtydxb/novamem          — TypeScript HTTP client
│   ├── mcp/           @azrtydxb/novamem-mcp      — stdio MCP shim
│   ├── init/          @azrtydxb/novamem-init     — interactive installer CLI
│   ├── admin-ui/      @azrtydxb/novamem-admin-ui — React 19 dashboard
│   └── docs-site/     @azrtydxb/novamem-docs-site — VitePress (this site)
├── docs/                       — markdown docs (legacy, mostly migrated to docs-site)
├── deploy/k8s/                 — Kubernetes manifests
├── site/                       — landing-page index.html + Pages output target
├── skills/                     — Agent Skills bundle
├── integrations/               — drop-in CLAUDE.md / commands for AI hosts
├── .changeset/                 — pending version bumps for the npm packages
├── .github/workflows/          — CI, Release, Pages
├── docker-compose.yaml         — single-host stack
├── go/Dockerfile               — multi-arch server image
├── pnpm-workspace.yaml
└── tsconfig.base.json          — root tsconfig with workspace path mappings
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

The TypeScript server it replaced (`packages/server`) was removed once
the Go server became the default and the conformance suite was green
against it; the git history is the archive.

## packages/admin-ui

React 19 + Vite + Tailwind v4. Pages live under `src/pages/`. Shared components in `src/components/`. Theme tokens (the Grid palette) in `src/index.css` via `@theme`.

The build outputs to `dist/`, then `go/scripts/sync-admin-ui.sh` copies it into `go/internal/httpapi/admin-ui/`, where `go:embed` bakes it into the binary. The server serves the SPA from there at `/admin/*`.

## packages/init

`npx @azrtydxb/novamem-init`. The CLI is `src/main.ts`, host adapters under `src/install/`. State persisted at `$XDG_CONFIG_HOME/novamem/init.json`.

## packages/mcp

Tiny wrapper that proxies stdio JSON-RPC ↔ SSE. Why it exists: many MCP hosts (Claude Desktop, VSCode extensions) don't support remote MCP yet.

## packages/client

Hand-written typed TypeScript client. Its types are kept in step with `docs/api/openapi.json`, which the Go server generates from its own route table.

## packages/docs-site

This site. VitePress + markdown. Builds into `site/docs/` so the Pages workflow picks both up.

## What lives in `docs/` vs `packages/docs-site/`

`docs/` is the legacy markdown — left intact for now so existing links keep working. New docs go into `packages/docs-site/`. The two will converge over time.

## How to find things

| I want to… | Look in |
|---|---|
| Add a new memory operation | `go/internal/engine/` + `go/internal/mcp/tooldefs.json` |
| Change the dashboard | `packages/admin-ui/src/pages/` |
| Tweak the install CLI | `packages/init/src/` |
| Update a doc | `packages/docs-site/<section>/` |
| Add an env var | `.env.example` + `go/internal/config/config.go` + `packages/docs-site/install/env-reference.md` |
| Fix a CI failure | `.github/workflows/` |
| Bump a package version | `pnpm changeset` (npm packages) or manual `chore(release):` PR (server) |
