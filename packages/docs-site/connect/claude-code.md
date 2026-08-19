# Connect Claude Code

Claude Code speaks remote MCP natively, so you point it at `/mcp/sse` directly — no shim, no `npx` for the runtime.

## One-shot installer (recommended)

```bash
npx @azrtydxb/novamem-init
```

Asks for the server URL + your dashboard email/password, mints a fresh `nm_…` bearer, detects Claude Code on your machine, and writes `.mcp.json` + the `commands/` bundle + the `CLAUDE.md` fragment for you. Idempotent — won't clobber existing config.

The rest of this page is the manual path — useful when you're scripting deployments or want to see what `novamem-init` actually wrote.

## Manual: project-local config

Drop a `.mcp.json` at your project root:

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

Replace `nm_…` with the bearer you minted from the dashboard's API Tokens page. Claude Code picks the file up automatically when you open a session in that directory.

For a global default, put the same `mcpServers` block in `~/.claude/settings.json` instead.

## Bundled drop-in

This repo ships a ready-to-copy bundle at [`integrations/claude-code/`](https://github.com/azrtydxb/novamem/tree/main/integrations/claude-code) with:

- `commands/` — slash commands like `/remember`, `/recall`, `/today`, `/forget`
- `CLAUDE.md` — behaviour rules describing when to call each MCP tool

Install in one go:

```bash
cp /path/to/novamem/integrations/claude-code/.mcp.json ./
mkdir -p .claude/commands
cp -r /path/to/novamem/integrations/claude-code/commands/. .claude/commands/
cat /path/to/novamem/integrations/claude-code/CLAUDE.md >> CLAUDE.md
```

The CLAUDE.md fragment is a fallback — the MCP server also ships the same behaviour rules via the protocol's `instructions` field on `initialize`, which Claude Code threads in automatically.

## Verify

In a Claude Code session:

```
/mcp
```

You should see `novamem` listed with the current NovaMem MCP tools (`memory_*` + `project_*`), including `memory_context`, `memory_capture`, and `memory_adoption`. Then verify the proactive protocol:

> I prefer pnpm over npm. What should you remember from this?

Claude should call `memory_context` before answering, then `memory_capture` to save the durable preference.

## Troubleshooting

- **`novamem` not listed** → check the bearer is valid (`curl -fsS -H "authorization: Bearer nm_..." http://localhost:7778/v1/me/tokens`). A revoked token shows up as a 401, the SSE handshake silently drops it.
- **Tools listed but every call returns 401** → bearer was revoked or the user was deleted. Mint a new one.
- **Connection refused** → verify the server is reachable from where Claude Code runs (e.g. inside WSL, `localhost` maps differently).

## Stdio fallback

If you need to point Claude Code at a host that can't reach the SSE endpoint directly, the stdio shim still works — see [Other clients + Skills](./others.md) for the shim config.
