# novamem

[![CI](https://github.com/azrtydxb/novamem/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/azrtydxb/novamem/actions/workflows/ci.yml)
[![Release](https://github.com/azrtydxb/novamem/actions/workflows/release.yml/badge.svg)](https://github.com/azrtydxb/novamem/actions/workflows/release.yml)
[![npm: client](https://img.shields.io/npm/v/%40azrtydxb%2Fnovamem.svg?label=%40azrtydxb%2Fnovamem&cacheSeconds=300)](https://www.npmjs.com/package/@azrtydxb/novamem)
[![npm: mcp](https://img.shields.io/npm/v/%40azrtydxb%2Fnovamem-mcp.svg?label=%40azrtydxb%2Fnovamem-mcp&cacheSeconds=300)](https://www.npmjs.com/package/@azrtydxb/novamem-mcp)
[![npm: init](https://img.shields.io/npm/v/%40azrtydxb%2Fnovamem-init.svg?label=%40azrtydxb%2Fnovamem-init&cacheSeconds=300)](https://www.npmjs.com/package/@azrtydxb/novamem-init)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node ≥ 20.19](https://img.shields.io/badge/node-%E2%89%A520.19-brightgreen.svg)](https://nodejs.org)

Standalone tiered memory service for AI agents. Hybrid keyword + vector + graph search, per-user isolation with shared sub-brains, MCP and HTTP transports, built-in dashboard.

```bash
cp .env.example .env
# Edit .env to set the three required secrets:
#   POSTGRES_PASSWORD=$(openssl rand -base64 24)
#   NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 24)
#   NOVAMEM_COOKIE_SECRET=$(openssl rand -hex 32)
docker compose up -d
curl http://localhost:7778/health
```

Compose itself enforces `POSTGRES_PASSWORD` and `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` at interpolation time and refuses to start without them. The server then refuses to start without `NOVAMEM_COOKIE_SECRET` (sessions need a stable secret across restarts). See [`.env.example`](.env.example) for the full reference and [`docs/install/docker.md`](docs/install/docker.md) for the long-form walkthrough.

## What it does

- **Tiered storage** — warm (Postgres FTS) + cold (Qdrant vectors) with synaptic decay (`effectiveDays = 7 · log₂(hits + 1)`) and reactive promotion on search hit
- **Hybrid retrieval** — keyword + vector + graph fused with min-max-normalised weighted scoring; weights overrideable per call
- **Worthiness gate** at write — hard-rule rejection of conversational filler + sha256 exact-duplicate fast-path
- **Dream cycle** — daily compaction (cosine ≥ 0.97 + Jaccard ≥ 0.5 dedup) + edge promotion (≥3 common neighbours)
- **Provenance fields** on every entry — `sourceType` / `capturedFrom` / `confidence`
- **Per-user isolation** with **projects** (sub-brains): share a project with another user by adding them as a member
- **Two transports** — HTTP/JSON and MCP (direct SSE + stdio shim for legacy hosts)
- **Built-in dashboard** at `/admin` — Better Auth (email + password), admin + user roles, metrics + 24h history
- **Pluggable embeddings** — local via `@xenova/transformers` (default, no API keys) or any OpenAI-compatible endpoint

## Documentation

Full docs live in [`docs/`](docs/):

- [Getting started](docs/getting-started.md)
- [Install — Manual](docs/install/manual.md) · [Docker Compose](docs/install/docker.md) · [Kubernetes](docs/install/kubernetes.md)
- [Connect — Claude Code](docs/connect/claude-code.md) · [Claude Desktop](docs/connect/claude-desktop.md) · [Cursor](docs/connect/cursor.md) · [Kilo Code](docs/connect/kilo-code.md) · [Other clients + Skills](docs/connect/others-and-skills.md)
- [Usage](docs/usage.md) — search, remember, projects, decay, dream cycle
- [Architecture](docs/architecture.md) — system shape + mermaid diagrams
- [API reference](docs/api/README.md) — generated OpenAPI 3.0 ([openapi.json](docs/api/openapi.json))
- [Security](SECURITY.md) — auth model, hardening checklist
- [Changelog](CHANGELOG.md)

## Packages

- [`@azrtydxb/novamem-server`](packages/server) — the standalone service (HTTP + MCP transports, Better Auth)
- [`@azrtydxb/novamem`](packages/client) — TypeScript client + public types
- [`@azrtydxb/novamem-mcp`](packages/mcp) — MCP-stdio shim binary for legacy clients that don't speak remote MCP yet
- [`@azrtydxb/novamem-init`](packages/init) — one-shot `npx` installer that signs in, mints a bearer, and wires every supported AI host on your machine
- [`@azrtydxb/novamem-admin-ui`](packages/admin-ui) — React 19 dashboard (built into the server image)

## Add-ons

- [`skills/novamem/`](skills/novamem) — [Agent Skills](https://agentskills.io)-compatible bundle (one skill, references for each tool group)
- [`integrations/`](integrations) — drop-in `CLAUDE.md` + slash commands for Claude Code and Kilo Code

## Status

Each package versions independently via [Changesets](https://github.com/changesets/changesets) — see [GitHub Releases](https://github.com/azrtydxb/novamem/releases) for the latest tag of each, or the npm badges above. The `/v1/*` API is stable; schema migrations are forward-only — back up Postgres before upgrading in place.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
