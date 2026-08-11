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
├── Dockerfile                  — multi-arch server image
├── pnpm-workspace.yaml
└── tsconfig.base.json          — root tsconfig with workspace path mappings
```

## packages/server

The bulk of the code. Subdirs:

```
src/
├── main.ts              — bootstrap: load config, start Fastify, seed admin
├── config.ts            — Zod-validated env schema
├── http.ts              — Fastify wiring: hooks, plugins, route registration
├── mcp.ts               — MCP server impl (in-process)
├── mcp-tools.ts         — tool definitions (single source for SSE + stdio)
├── mcp-instructions.ts  — NOVAMEM_INSTRUCTIONS for the agent
├── openapi.ts           — Swagger generation
├── engine/              — MemoryEngine: search, remember, neighbors, decay…
├── warm-store/          — Postgres + drizzle layer
├── cold-store.ts        — Qdrant client wrapper
├── routes/              — per-section route registration (data-plane, admin, me, mcp-sse, auth)
├── admin/               — metrics + audit-log helpers
└── *.test.ts            — colocated vitest specs
```

## packages/admin-ui

React 19 + Vite + Tailwind v4. Pages live under `src/pages/`. Shared components in `src/components/`. Theme tokens (the Grid palette) in `src/index.css` via `@theme`.

The build outputs to `dist/`, then a `build:assets` step in the server's pretest hook copies it into `packages/server/dist/admin/ui/`. The server serves the SPA from there at `/admin/*`.

## packages/init

`npx @azrtydxb/novamem-init`. The CLI is `src/main.ts`, host adapters under `src/install/`. State persisted at `$XDG_CONFIG_HOME/novamem/init.json`.

## packages/mcp

Tiny wrapper that proxies stdio JSON-RPC ↔ SSE. Why it exists: many MCP hosts (Claude Desktop, VSCode extensions) don't support remote MCP yet.

## packages/client

Hand-written typed TypeScript client. Re-exports the request/response types from `packages/server/src/types.ts` so a consumer of the client gets the same types the server emits.

## packages/docs-site

This site. VitePress + markdown. Builds into `site/docs/` so the Pages workflow picks both up.

## What lives in `docs/` vs `packages/docs-site/`

`docs/` is the legacy markdown — left intact for now so existing links keep working. New docs go into `packages/docs-site/`. The two will converge over time.

## How to find things

| I want to… | Look in |
|---|---|
| Add a new memory operation | `packages/server/src/engine/index.ts` + `packages/server/src/mcp-tools.ts` |
| Change the dashboard | `packages/admin-ui/src/pages/` |
| Tweak the install CLI | `packages/init/src/` |
| Update a doc | `packages/docs-site/<section>/` |
| Add an env var | `.env.example` + `packages/server/src/config.ts` + `packages/docs-site/install/env-reference.md` |
| Fix a CI failure | `.github/workflows/` |
| Bump a package version | `pnpm changeset` (npm packages) or manual `chore(release):` PR (server) |
