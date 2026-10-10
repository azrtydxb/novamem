---
title: novamem-init CLI reference
---

# novamem-init CLI reference

`novamem-init` is a Go binary that connects supported AI hosts to a novamem server. It can sign in and mint a bearer, or use an existing bearer, then writes each selected host's MCP configuration and supported skill or command files.

Install the CLI binaries with the [release installer](../contribute/releases.md#installing), then run:

```bash
novamem-init
```

## Connect directly

The server exposes MCP at `/mcp`. For hosts that support remote MCP, add this entry to the host's MCP configuration, replacing the URL and bearer with your values:

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

The Go CLI configures hosts that require a local stdio process with the shipped `novamem-mcp` binary. It locates the binary beside `novamem-init`, or on `PATH`; use `--mcp-bin` to specify another path. See [Other clients + Skills](./others.md) for manual remote MCP configuration.

## Flags

```
novamem-init [flags]
```

| Flag | Description |
| --- | --- |
| `--base-url <url>` | novamem server URL (or `NOVAMEM_BASE_URL`). |
| `--email <addr>` | Dashboard email; skips the email prompt. |
| `--password <pw>` | Dashboard password; prefer `NOVAMEM_PASSWORD` to avoid shell history. |
| `--token <bearer>` | Use an existing `nm_…` bearer and skip sign-in (or set `NOVAMEM_TOKEN`). |
| `--tools <ids>` | Comma-separated host IDs to configure. |
| `--all` | Configure every supported host, whether detected or not. |
| `--yes`, `-y` | Non-interactive; accept defaults without confirmation. |
| `--dry-run` | Preview paths without writing files. |
| `--mcp-bin <path>` | Path to the `novamem-mcp` binary (default: beside this binary, then `PATH`). |
| `--skip-shim-check` | Skip checking that the local binary runs before writing stdio configuration. |
| `--version` | Print the version and exit. |
| `--help` | Print usage and supported host IDs. |

## Manual connection

For a client that supports remote MCP, configure the `/mcp` endpoint and an API bearer as shown above. Create or revoke bearers from the dashboard's API Tokens page. Check server reachability at `/health` if the client cannot connect.

## Troubleshooting

- **Server unreachable** — confirm the server URL is reachable from the machine running the AI client.
- **401 responses** — mint a new bearer if the token was revoked, and update the host configuration.
- **stdio host does not start** — ensure the `novamem-mcp` binary is executable and beside `novamem-init` or available on `PATH`; use `--mcp-bin` if needed.

## See also

- [Claude Code setup](./claude-code.md)
- [Other clients + Skills](./others.md)
- [API tokens](../dashboard/tokens.md)
