---
title: novamem · documentation
---

# novamem documentation

**One memory across every AI agent you use.** Hybrid keyword + vector + graph retrieval, per-user isolation with shareable sub-brains, MCP and HTTP transports, built-in dashboard. Self-hostable on a laptop or as a multi-tenant brain for a whole company.

This is the long-form documentation. For the marketing landing page see [novamem.github.io/novamem](https://azrtydxb.github.io/novamem/). For source see [github.com/azrtydxb/novamem](https://github.com/azrtydxb/novamem).

::: tip Where to start
- New to novamem? → [Getting started](/getting-started)
- Standing up a server? → [Docker Compose](/install/docker-compose) or [Kubernetes](/install/kubernetes)
- Connecting your AI host? → [novamem-init CLI](/connect/init-cli)
- Understanding the model? → [Mental model](/concepts/mental-model)
:::

## What's here

| Section | Goes deep on |
|---|---|
| **Install** | Docker Compose env reference, Kubernetes manifest walkthrough, manual Postgres + Qdrant + FalkorDB setup |
| **Connect agents** | The `npx @azrtydxb/novamem-init` CLI in detail; per-host (Claude Code, Desktop, ChatGPT, Cursor, Cline, Continue, Kilo, others); custom HTTP integration |
| **Dashboard** | Sign-in & roles, every page tour, projects + sharing, tenant + user admin, API tokens |
| **Architecture** | System shape, tiered storage, hybrid search internals, worthiness gate + dedup, decay maths + dream cycle, multi-tenancy |
| **API reference** | Auth flows, the data plane, admin & users, MCP tools, OpenAPI spec |
| **Operations** | Security model, hardening checklist, audit log, backup/restore, upgrades |
| **Contribute** | Local dev setup, project layout, testing, release flow, filing bugs |

## Three minutes overview

novamem is a single Fastify server that holds memory entries for AI agents and exposes two equivalent transports — JSON HTTP and the Model Context Protocol. Entries flow through three storage layers:

- **Warm tier** — Postgres full-text search, low-latency hot path
- **Cold tier** — Qdrant vector embeddings, semantic recall over older entries
- **Graph tier** — FalkorDB edges between related memories, surfaces adjacent context

Every search runs all three signals in parallel and fuses them into one ranked list. Per-user isolation is the default; **projects** are sub-brains that can be shared with other users for team workflows.

The same code runs on a laptop (Docker Compose, single user) or as a multi-tenant deployment on Kubernetes.
