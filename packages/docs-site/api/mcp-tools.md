---
title: MCP tools
---

# MCP tools

novamem advertises 14 tools via the Model Context Protocol. The same shapes live in [`packages/server/src/mcp-tools.ts`](https://github.com/azrtydxb/novamem/blob/main/packages/server/src/mcp-tools.ts) — single source of truth for both the in-process server (used by `/mcp/sse`) and the stdio shim (`@azrtydxb/novamem-mcp`).

## Memory tools

| Tool | Purpose |
|---|---|
| `memory_search` | Hybrid retrieval. See [data plane](/api/data-plane#post-v1-search) for full args. |
| `memory_remember` | Write a new entry. Worthiness gate + dedup applied. |
| `memory_recent` | Newest-first feed. Optional `since` window. |
| `memory_today` | Convenience wrapper around `recent` with a 24 h `since`. |
| `memory_neighbors` | Graph traversal from a seed id. Depth 1–3. |
| `memory_forget` | Hard delete by id. Idempotent. |
| `memory_update` | In-place rewrite; preserves id + edges + hits. |
| `memory_stats` | Per-caller byNamespace counts + totals. |

## Project tools

| Tool | Purpose |
|---|---|
| `project_create` | Create a new sub-brain; caller becomes owner. |
| `project_list` | List projects the caller belongs to. |
| `project_activate` | Set active project for subsequent calls (server-side state). |
| `project_deactivate` | Clear active project. |
| `project_share` | Add a member by username. |
| `project_unshare` | Remove a member. |
| `project_delete` | Owner-only cascade delete. |

## Transports

Two equivalent paths:

### SSE — recommended

```
GET  /mcp/sse              — opens the event stream
POST /mcp/messages?sessionId=…  — sends JSON-RPC requests
```

Connect with `Authorization: Bearer nm_…`. The session id is returned in the first SSE event. The route enforces:

- `MAX_SESSIONS_PER_USER = 10` — concurrency cap, returns 429
- 30 min idle timeout — sessions with no `POST /mcp/messages` activity are reaped
- `: ping\n\n` keepalive every 25 s — prevents undici 5-min body timeout

### stdio shim

The `@azrtydxb/novamem-mcp` package proxies stdio JSON-RPC ↔ SSE. Used by hosts that don't support remote MCP yet (most desktop apps).

```bash
NOVAMEM_BASE_URL=https://novamem.example.com \
NOVAMEM_TOKEN=nm_... \
  npx -y @azrtydxb/novamem-mcp
```

Pin the version (`@1.2.0`) for reproducibility.

## Conventions

- All ids are ULIDs (`01H…`), 26 chars.
- Timestamps are ISO-8601 with a `Z` suffix.
- Optional fields default to sensible values; the server documents the defaults via the OpenAPI spec.
- Errors come back as MCP `error` responses with a structured shape; the dashboard / CLI shows the human message.

## See also

- [Mental model](/concepts/mental-model)
- [Hybrid search internals](/architecture/hybrid-search)
- [novamem-init CLI](/connect/init-cli) — wires the SSE/stdio config for you
