# @azrtydxb/novamem-mcp

MCP-stdio shim for [novamem](https://github.com/azrtydxb/novamem). Bridges stdio↔HTTP for MCP hosts that haven't shipped remote-MCP support yet (older Claude Desktop, Cursor, …).

```bash
npx @azrtydxb/novamem-mcp
```

> If your client supports remote MCP, point it directly at `http://<host>:7778/mcp/sse` instead — no shim needed. See the main repo's README for the SSE config shape.

## MCP shim

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azrtydxb/novamem-mcp"],
      "env": {
        "NOVAMEM_BASE_URL": "http://localhost:7778",
        "NOVAMEM_TOKEN": "nm_…"
      }
    }
  }
}
```

`NOVAMEM_TOKEN` is a `nm_…` user bearer minted from the dashboard's API Tokens page. It carries every right the owning user has — the user's whole memory plus every project they're a member of.

## Tools advertised

Memory operations (every tool accepts an optional `project` — id or human name):

- `memory_context` / `memory_capture` / `memory_session_recap` / `memory_hygiene` / `memory_evaluate` / `memory_search` / `memory_remember` / `memory_update` / `memory_recent` / `memory_today` / `memory_neighbors` / `memory_forget` / `memory_stats`
- `memory_remember` accepts `sourceType`, `capturedFrom`, `confidence`, and `force` (bypass the worthiness gate)
- `memory_update` rewrites an existing entry in place; preserves id + hits + edges; re-embeds when content changes

Project lifecycle:

- `project_list` / `project_create` / `project_delete`
- `project_activate({ project })` / `project_deactivate` — set or clear the caller's active project. When set, memory_* calls without an explicit `project` arg default to it.
- `project_share({ project, username })` / `project_unshare(...)` — owner adds/removes members by their **exact email address** (the server resolves via `findUserByExactEmail`).

## See also

- [SECURITY.md](https://github.com/azrtydxb/novamem/blob/main/SECURITY.md) — auth model and hardening checklist
- Main repo for the OpenAPI spec, dashboard, and HTTP API
