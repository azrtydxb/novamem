# @azrty/novamem-mcp

MCP-stdio shim for [novamem](https://github.com/azrtydxb/novamem). Bridges stdio↔HTTP for MCP hosts that haven't shipped remote-MCP support yet (older Claude Desktop, Cursor, …).

```bash
npx @azrty/novamem-mcp
```

> If your client supports remote MCP, point it directly at `http://<host>:7778/mcp/sse` instead — no shim needed. See the main repo's README for the SSE config shape.

## MCP shim

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azrty/novamem-mcp"],
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

- `memory.search` / `memory.remember` / `memory.update` / `memory.recent` / `memory.today` / `memory.neighbors` / `memory.forget` / `memory.stats`
- `memory.remember` accepts `sourceType`, `capturedFrom`, `confidence`, and `force` (bypass the worthiness gate)
- `memory.update` rewrites an existing entry in place; preserves id + hits + edges; re-embeds when content changes

Project lifecycle:

- `project.list` / `project.create` / `project.delete`
- `project.activate({ project })` / `project.deactivate` — set or clear the caller's active project. When set, memory.* calls without an explicit `project` arg default to it.
- `project.share({ project, username })` / `project.unshare(...)` — owner adds/removes members by email or display name.

## See also

- [SECURITY.md](https://github.com/azrtydxb/novamem/blob/main/SECURITY.md) — auth model and hardening checklist
- Main repo for the OpenAPI spec, dashboard, and HTTP API
