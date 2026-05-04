# Connect Cursor

Cursor reads MCP config from `~/.cursor/mcp.json` (global) or `<workspace>/.cursor/mcp.json` (project-local). Recent versions support remote MCP; older versions need the stdio shim.

## Recommended: direct SSE

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "novamem": {
      "type": "sse",
      "url": "http://localhost:7778/mcp/sse",
      "headers": { "Authorization": "Bearer nm_..." }
    }
  }
}
```

Open Cursor's settings → MCP and you should see `novamem` connected with 15 tools listed.

## Stdio shim

For older Cursor builds:

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azertydxb/novamem-mcp"],
      "env": {
        "NOVAMEM_BASE_URL": "http://localhost:7778",
        "NOVAMEM_TOKEN": "nm_..."
      }
    }
  }
}
```

## Verify

Open the Composer / Agent and ask:

> Remember that this project uses Tailwind v4 (CSS-native config, not tailwind.config.js).

Cursor should call `memory_remember`. Then in a fresh session:

> What styling system does this project use?

It should call `memory_search` and surface the answer.

## Project-scoped memories

If you want every memory written from this Cursor workspace to land in a specific project (sub-brain) rather than user-global memory, ask the agent once per session:

> Activate the "phoenix" project for memory.

Cursor will call `project_activate({ project: "phoenix" })`. Subsequent `memory_*` calls without an explicit `project` arg default to that project until you call `project_deactivate` or change workspaces.

## Troubleshooting

- **Tools listed but greyed out** → Cursor's MCP toggle for the server is off. Settings → MCP → switch `novamem` on.
- **401** → token revoked; mint a new one and update `mcp.json`.
- **Server unreachable** → confirm with `curl http://localhost:7778/health` from the same machine Cursor runs on. If novamem is on a different host, set `url` accordingly.
