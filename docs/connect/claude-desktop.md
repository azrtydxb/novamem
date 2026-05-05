# Connect Claude Desktop

Claude Desktop's MCP loader only accepts **stdio** entries (`command` + `args`). Writing `{"type": "sse", "url": …}` produces "not valid MCP server configurations and were skipped: novamem" on launch — even on the most recent builds. Use the stdio shim, which runs locally and bridges to the server's `/mcp/sse` endpoint with your bearer.

## One-shot installer (recommended)

```bash
npx @azrtydxb/novamem-init
```

Signs you in, mints a fresh `nm_…` bearer, finds Claude Desktop's `claude_desktop_config.json` (macOS/Windows/Linux), and merges the `novamem` MCP entry into it. Idempotent.

The rest of this page is the manual path.

## Manual: stdio shim

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azrtydxb/novamem-mcp"],
      "env": {
        "NOVAMEM_BASE_URL": "http://localhost:7778",
        "NOVAMEM_TOKEN": "nm_..."
      }
    }
  }
}
```

The shim spawns a Node process that bridges stdio↔HTTP against the same endpoints any other client uses.

## Verify

Open a chat and ask:

> What MCP tools do you have available?

Claude should list `memory_search`, `memory_remember`, etc. Then:

> Remember that my preferred timezone is UTC.

It should call `memory_remember` and confirm.

## Troubleshooting

- **`novamem` doesn't appear** → check `claude_desktop_config.json` is valid JSON (commas, quotes), then **quit Claude Desktop fully** (Cmd-Q on macOS) and reopen — it doesn't hot-reload.
- **`spawn npx ENOENT`** with the stdio shim → Claude Desktop can't find Node on its PATH. Use the absolute path: `"command": "/usr/local/bin/npx"` on macOS, or `"command": "node", "args": ["/abs/path/to/novamem-mcp/dist/cli.js"]`.
- **401 on every call** → bearer revoked or pointing at the wrong host. Test with `curl -fsS -H "authorization: Bearer nm_..." http://localhost:7778/v1/me/tokens`.
- **Server on a different machine** → replace `localhost:7778` with the reachable URL. If the host has no TLS, Claude Desktop on macOS may refuse non-HTTPS — put a TLS-terminating proxy in front (Caddy makes this trivial) and update `NOVAMEM_BASE_URL` on the server to match.
