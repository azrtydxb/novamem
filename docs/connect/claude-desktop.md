# Connect Claude Desktop

Configure Claude Desktop to connect directly to the server's remote MCP endpoint at `/mcp`.

## Configure

Install the Go CLI binaries with the [release installer](../contribute/releases.md#installing), then run `novamem-init` to configure supported hosts. For manual setup, add the following to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "novamem": {
      "type": "http",
      "url": "https://your.novamem/mcp",
      "headers": { "Authorization": "Bearer nm_..." }
    }
  }
}
```

Replace the URL and bearer with values for your server. Restart Claude Desktop after changing its configuration.

## Verify

Open a chat and ask which MCP tools are available. Claude should list the current NovaMem tools, including `memory_search` and `memory_remember`.

## Troubleshooting

- **Server unavailable** — confirm the URL is reachable from the same machine and that it uses HTTPS when required by your Claude Desktop version.
- **401 responses** — mint a new bearer from the dashboard and update the configuration.
