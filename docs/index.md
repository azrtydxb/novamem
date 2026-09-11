---
title: novamem · documentation
---

# novamem documentation

**One memory across every AI agent you use.** Hybrid keyword + vector + graph + recency + entity retrieval (5-signal engine, graph/entity defaulted to 0 in production calibration), per-user isolation with shareable sub-brains, MCP and HTTP transports, built-in dashboard. Integrates with 30+ AI agent hosts. Self-hostable on a laptop or as a multi-tenant brain for a whole company. pgvector as an alternative to Qdrant for the cold vector tier.

This is the long-form documentation. For the marketing landing page see [novamem.github.io/novamem](https://azrtydxb.github.io/novamem/). For source see [github.com/azrtydxb/novamem](https://github.com/azrtydxb/novamem).

::: tip Where to start

- New to novamem? → [Getting started](./getting-started.md)
- Standing up a server? → [Docker Compose](./install/docker-compose.md) or [Kubernetes](./install/kubernetes.md)
- Connecting your AI host? → [novamem-init CLI](./connect/init-cli.md)
- Understanding the model? → [Mental model](./concepts/mental-model.md)
  :::

## What's here

| Section            | Goes deep on                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Install**        | Docker Compose env reference, Kubernetes manifest walkthrough, manual Postgres + Qdrant setup                                                            |
| **Connect agents** | The `npx @azrtydxb/novamem-init` CLI in detail; per-host (Claude Code, Desktop, ChatGPT, Cursor, Cline, Continue, Kilo, others); custom HTTP integration |
| **Dashboard**      | Sign-in & roles, every page tour, projects + sharing, tenant + user admin, API tokens                                                                    |
| **Architecture**   | System shape, tiered storage, hybrid search internals, worthiness gate + dedup, decay maths + dream cycle, multi-tenancy                                 |
| **API reference**  | Auth flows, the data plane, admin & users, MCP tools, OpenAPI spec                                                                                       |
| **Operations**     | Security model, hardening checklist, audit log, backup/restore, upgrades                                                                                 |
| **Contribute**     | Local dev setup, project layout, testing, release flow, filing bugs                                                                                      |

## Three minutes overview

novamem is a single Fastify server that holds memory entries for AI agents and exposes two equivalent transports — JSON HTTP and the Model Context Protocol. Entries flow through five layers:

- **Warm tier** — Postgres full-text search, low-latency hot path
- **Cold tier** — Qdrant or pgvector vector embeddings, semantic recall over older entries
- **Relations** — co-occurrence edges in Postgres (`memory_relations`), traversed by `/v1/neighbors`
- **Recency** — exponential decay rank prior applied on search results
- **Entity bridge** — exact identifier bridging via extracted identifiers from the query (currently at weight 0 in production)

Search fuses five signals — Postgres full-text keyword match, Qdrant/pgvector vector similarity, graph adjacency, recency rank prior, and entity bridge — with an optional cross-encoder rerank; adjacency between memories is served separately by `/v1/neighbors` over the `memory_relations` table.

The same code runs on a laptop (Docker Compose, single user) or as a multi-tenant deployment on Kubernetes, supporting 30+ AI agent hosts via the `novamem-init` CLI.
