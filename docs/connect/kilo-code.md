# Connect Kilo Code

[Kilo Code](https://kilocode.ai) reads project-scoped rules, slash commands, and MCP config from `.kilocode/`. The structure mirrors Claude Code, so the same content works with small path tweaks.

## MCP config

Either drop a `.mcp.json` at the project root (Kilo honours the same file Claude Code does) or paste into `.kilocode/mcp.json`:

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

For Kilo builds without remote-MCP support, fall back to the stdio shim:

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

## Rules + slash commands

This repo ships a Kilo-shaped bundle. Run from your project root:

```bash
mkdir -p .kilocode/rules .kilocode/commands

# Behaviour rules (when to call memory_* / project_*)
cp /path/to/novamem/integrations/claude-code/CLAUDE.md \
   .kilocode/rules/novamem.md

# Slash commands map 1:1
cp /path/to/novamem/integrations/claude-code/commands/*.md \
   .kilocode/commands/
```

The slash commands include `/remember`, `/recall`, `/today`, `/forget`, `/projects`, `/neighbors`, etc. Each one's `allowed-tools` frontmatter resolves the MCP tool by `<server>__<tool>` — Kilo uses the same separator as Claude Code.

The bundled `integrations/kilo-code/README.md` has the source-of-truth install steps.

## Verify

Open a session in the project and ask:

> Remember that this repo uses pnpm workspaces.

Kilo should call `memory_remember`. Then `/recall pnpm` to check it round-trips.

## Troubleshooting

- **Slash commands not appearing** → confirm files landed in `.kilocode/commands/` (not `.claude/commands/`); Kilo doesn't read the Claude Code path.
- **MCP server doesn't connect** → check Kilo's MCP panel for the server status; restart Kilo after editing the JSON config (it doesn't hot-reload).
- **401** → bearer revoked; mint a new one in the dashboard and update the JSON.
