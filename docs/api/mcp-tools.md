---
title: MCP tools
---

# MCP tools

novamem advertises 21 tools via the Model Context Protocol. The same shapes live in [`go/internal/mcp/tooldefs.json`](https://github.com/azrtydxb/novamem/blob/main/go/internal/mcp/tooldefs.json) — single source of truth for the three transports the server exposes (Streamable HTTP, legacy SSE, and the stdio-shim bridge).

## Memory tools

| Tool                   | Purpose                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_context`       | Low-friction first-pass grounding for the current user message; combines relevant search + recent context.                                                            |
| `memory_search`        | Hybrid retrieval. See [data plane](./data-plane.md#post-v1-search) for full args.                                                                                     |
| `memory_capture`       | Preferred agent-facing durable write. Applies provenance defaults, typed `memoryType`, worthiness scoring, semantic duplicate/update, and contradiction supersession. |
| `memory_session_recap` | Batch ingest curated end-of-session recap items as typed durable memories.                                                                                            |
| `memory_hygiene`       | Read-only curation report: low-value, stale, duplicate, contradiction, and orphan candidates.                                                                         |
| `memory_evaluate`      | Built-in memory-quality evaluation scenarios.                                                                                                                         |
| `memory_adoption`      | Read-only client adoption report: current tool surface, instructions hash, feature flags, diagnostics, and refresh guidance.                                          |
| `memory_remember`      | Raw write of a new entry. Worthiness gate + exact SHA dedup applied.                                                                                                  |
| `memory_recent`        | Newest-first feed. Optional `since` window.                                                                                                                           |
| `memory_today`         | Convenience wrapper around `recent` with a 24 h `since`.                                                                                                              |
| `memory_neighbors`     | Graph traversal from a seed id. Depth 1–3.                                                                                                                            |
| `memory_forget`        | Hard delete by id. Idempotent.                                                                                                                                        |
| `memory_update`        | Manual in-place rewrite when you already know the entry id; preserves id + edges + hits.                                                                              |
| `memory_stats`         | Per-caller byNamespace counts + totals.                                                                                                                               |

## Project tools

| Tool                 | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `project_create`     | Create a new sub-brain; caller becomes owner.                |
| `project_list`       | List projects the caller belongs to.                         |
| `project_activate`   | Set active project for subsequent calls (server-side state). |
| `project_deactivate` | Clear active project.                                        |
| `project_share`      | Add a member by exact invitee email.                         |
| `project_unshare`    | Remove a member.                                             |
| `project_delete`     | Owner-only cascade delete.                                   |

## Transports

Three equivalent paths:

### Streamable HTTP — recommended for new clients

The current MCP spec (2025-03-26). Single endpoint, content-negotiated:

```
POST   /mcp   — JSON-RPC requests; `initialize` without Mcp-Session-Id starts a session
GET    /mcp   — opens server→client SSE channel for an existing session
DELETE /mcp   — terminates a session
```

Connect with `Authorization: Bearer nm_…`. Session id is returned in the `Mcp-Session-Id` response header on the initialize POST and must be echoed on every subsequent request. Session ownership is bound to the bearer holder — a leaked session id can't be driven by a different authenticated user.

What clients speak this transport: OpenAI Codex CLI, recent Cursor / Kilo Code (auto-detect with SSE fallback), GitHub Copilot in VS Code, anything built on the Rust `rmcp` crate.

### Legacy HTTP+SSE — removed

`GET /mcp/sse` + `POST /mcp/messages?sessionId=…` was the two-endpoint transport from protocol revision `2024-11-05`. The spec [Deprecated it](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) in `2025-03-26`, and novamem removed it (ADR 0007). Both paths now answer the 404 envelope.

Everything it served is served by `/mcp`, which speaks both protocol eras. A client still configured for the old pair needs its `url` changed to `/mcp` and its `type` to `http`; `novamem-init` writes that shape now.

### stdio shim

`novamem-mcp` proxies stdio JSON-RPC ↔ Streamable HTTP. Used by hosts that don't support remote MCP at all (Claude Desktop) or whose remote-MCP implementation is broken.

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

- [Mental model](../concepts/mental-model.md)
- [Hybrid search internals](../architecture/hybrid-search.md)
- [novamem-init CLI](../connect/init-cli.md) — wires the SSE/stdio config for you
