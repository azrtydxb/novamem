# novamem documentation

Tiered long-term memory for AI agents — keyword + vector + graph hybrid search, per-user isolation with shared sub-brains, MCP and HTTP transports, built-in dashboard.

## Start here

- [Getting started](getting-started.md) — pick an install path, mint a token, store your first memory
- [Usage](usage.md) — search, remember, projects, the worthiness gate, decay
- [Memory recall benchmarks](evaluation-benchmarks.md) — LongMemEval/LoCoMo/BEIR/RAG/RULER-style benchmark adapters and live NovaMem runner
- [Observability](observability.md) — OpenTelemetry/Jaeger tracing for production and benchmark diagnosis
- [Architecture](architecture.md) — system shape, data tiering, ownership model, mermaid diagrams

## Install

- [Docker Compose](install/docker.md) — single-host all-in-one, recommended for development and small deployments
- [Kubernetes](install/kubernetes.md) — k3s manifests under `deploy/k8s/`, single-replica StatefulSets

## Connect an AI tool

**One-shot installer**: `npx @azrtydxb/novamem-init` signs you in, mints a bearer, and wires every supported host on your machine. See [`@azrtydxb/novamem-init`](../packages/init/README.md).

Or pick your host manually — each guide has the exact MCP config block to paste:

- [Claude Code](connect/claude-code.md)
- [Claude Desktop](connect/claude-desktop.md)
- [Cursor](connect/cursor.md)
- [Kilo Code](connect/kilo-code.md)
- [Other clients + the Skills add-on](connect/others-and-skills.md) — Goose, OpenCode, Continue, plus the agentskills.io skill bundle for clients without MCP

## Reference

- [API](api/README.md) — generated OpenAPI 3.0 spec ([openapi.json](api/openapi.json)); live Swagger UI at `/api-docs` on a running server
- [Security](../SECURITY.md) — auth model, hardening checklist, threat model
- [Changelog](../CHANGELOG.md)

## Repository layout

```
.
├── packages/
│   ├── server/        # Fastify HTTP + MCP transports, MemoryEngine, Better Auth
│   ├── client/        # @azrtydxb/novamem — TypeScript client + public types
│   ├── mcp/           # @azrtydxb/novamem-mcp — stdio shim for legacy clients
│   └── admin-ui/      # React 19 + Vite dashboard (built into the server image)
├── skills/novamem/    # Agent Skills bundle (agentskills.io spec)
├── integrations/      # Drop-in CLAUDE.md + MCP config per agent host
├── deploy/k8s/        # Kustomize manifests for k3s
├── docs/              # You are here
├── docker-compose.yaml
├── Dockerfile
├── README.md          # Landing page → links here
├── CHANGELOG.md
├── SECURITY.md
└── LICENSE
```
