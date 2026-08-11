---
title: Glossary
---

# Glossary

## active project

The project the dashboard's sidebar switcher currently points at. Persisted in `localStorage` (`nm-active-project`). Determines the scope of subsequent search / recent / today / graph calls.

## audit log

The `admin_audit_log` Postgres table. Every administrative action (user create, role change, tenant delete, …) writes a row attributed to the calling actor.

## Better Auth

The dashboard's authentication library — sessions, email + password, admin plugin. Source of truth for users, sessions, and the admin RBAC. Tables: `user`, `session`, `account`, `verification`, `jwks`.

## bearer token

A `nm_…` (tenant) or `ns_…` (session) prefixed string sent as `Authorization: Bearer …`. Resolves to a tenant id / user id at the server.

## cold tier

The Qdrant vector store. Embeddings of every memory entry, plus the source-of-truth for entries that have decayed off the warm tier.

## decay

Synaptic decay — the sweep that demotes warm entries past their effective lifespan (`7 · log₂(hits + 1)` days) to cold-only.

## degraded

Search response field set to `true` when one of the retrieval tiers (warm / cold) errored. The remaining tier's results are still returned.

## dream cycle

The nightly compaction job: cosine + Jaccard dedup of similar entries, plus edge promotion for shared-neighbour clusters in `memory_relations`.

## entry

A single memory record. Belongs to one user, optionally one project, lives in a namespace, has an embedding, has relation edges. Identified by a ULID.

## hybrid search

Running keyword (FTS) + vector (cosine) in parallel, normalising each score, then weighted-summing into one ranked list. `weights.graph` / `weights.entity` are still accepted on the wire but contribute nothing.

## init / `novamem-init`

The CLI (`@azrtydxb/novamem-init`) that signs into a server, mints a bearer, detects every supported AI host on your machine, and writes the per-host config.

## member

A user who is in a project's `project_members` table. Members can read + write the project's memory but can't add / remove other members.

## memory_relations

The Postgres table holding co-occurrence edges between memories (bitemporal `valid_from`/`valid_to`, per-edge `kind` + `strength`). Written asynchronously after each memory behind a durable `graph_pending_at` marker; traversed by `/v1/neighbors` with a recursive CTE. Replaced the dedicated graph service in Phase 7.

## metadata

Free-form `jsonb` attached to a memory entry. Indexed by Postgres but not searched by default. Use for stable structured fields (e.g. `{ commit: "abc123" }`).

## namespace

A within-scope shelf for organising memory entries. The same content can live under multiple namespaces in different scopes. Default: `"default"`.

## owner

The user who created a project. Has additional powers: add/remove members, delete the project. Cannot transfer ownership.

## project

A sub-brain — a shared scope for memory across multiple users. Membership is explicit; entries within are visible to every member.

## project pinning

A bearer token can have a `projectId` set, which limits its data-plane access to that project only. Cross-project requests with that token return 403.

## reactive promotion

When a search hit lands on a cold-only entry whose accumulated lifespan now exceeds its idle days, the engine moves it back to warm so subsequent searches hit the fast path.

## session

A Better Auth session — HttpOnly cookie + DB-backed token. Carries the user id + role for dashboard requests.

## SSE

Server-Sent Events. The transport for the live MCP path (`/mcp/sse`). One long-lived connection from the client; server pushes JSON-RPC frames. Keepalive frames (`: ping`) every 25 s prevent client body-read timeout.

## stdio shim

The `@azrtydxb/novamem-mcp` package — a tiny Node CLI that proxies stdio JSON-RPC ↔ remote SSE for hosts that don't support remote MCP yet.

## tenant

The top-level isolation boundary. Each tenant has its own users, projects, tokens, memory. `PUBLIC_TENANT` is the implicit single-tenant for solo deploys.

## tenant token

A `nm_…` bearer minted via the dashboard or `/v1/me/tokens`. Authorizes data-plane calls. Stored as SHA-256 hash; plaintext shown once.

## tier

One of warm / cold. Each is a different storage layer; entries flow between them based on access patterns.

## tsvector

Postgres's full-text index column type. novamem maintains one on `memory_entries.content` via a generated column, refreshed by trigger on every insert / update.

## ULID

26-char lexicographically-sortable unique id. Used everywhere instead of UUIDs because they sort by creation time.

## user-global

Memory entries with `projectId IS NULL`. Private to one user; invisible to everyone else. The default scope when no project is active.

## warm tier

The Postgres FTS index over `memory_entries`. Hot path for keyword recall over recent + frequent entries.

## worthiness gate

The hard-rule check that runs before `memory_remember` writes anything: rejects content under 12 chars, single-word filler ("ok", "thanks", …). Bypassable with `force: true`.
