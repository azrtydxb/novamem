---
title: novamem-init CLI reference
---

# `@azrtydxb/novamem-init` — full CLI reference

The init CLI is the single command that:

1. Asks for your novamem server URL
2. Signs you in with your dashboard credentials (or seeds the bootstrap admin)
3. Mints a fresh `nm_…` bearer token
4. Detects every supported AI host on your machine
5. Writes the per-host config each one expects

Idempotent — re-running merges into existing config rather than overwriting.

## Quick run

```bash
npx -y @azrtydxb/novamem-init
```

That's it for the happy path. Re-runs prefill the server URL + email from the previous answer (stored in `$XDG_CONFIG_HOME/novamem/init.json`).

## What it writes

For each AI host detected, init writes (or merges into) the canonical config file:

| Host | File | Transport |
|---|---|---|
| Claude Code | `<project>/.mcp.json` + `<project>/CLAUDE.md` + `<project>/commands/` | SSE |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows) · `~/.config/Claude/claude_desktop_config.json` (Linux) | stdio shim |
| Cursor | `~/.cursor/mcp.json` | SSE |
| Cline | `<vscode>/User/globalStorage/saoudrizwan.claude-dev/cline_mcp_settings.json` | SSE |
| Continue | `~/.continue/config.json` (`mcpServers`) | SSE |
| Kilo Code | `<vscode>/User/globalStorage/.../kilo-code/mcp_settings.json` | SSE |
| OpenCode | `~/.config/opencode/config.json` | SSE |
| Codex CLI | `~/.codex/config.toml` | SSE |
| RooCode | `<vscode>/User/globalStorage/.../roocode/mcp_settings.json` | SSE |
| Gemini CLI | `~/.gemini/config.json` | SSE |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | SSE |
| Factory | `~/.factory/config.json` | SSE |
| Amazon Q | `~/.aws/amazonq/mcp.json` | SSE |
| Skill-only hosts (16+) | platform-specific skill bundle | Agent Skills |

## Flags

```
novamem-init [options]
```

| Flag | Description |
|---|---|
| `--server <url>` | Pre-set the server URL (skip the first prompt). |
| `--email <addr>` | Pre-set the email (skip the email prompt). |
| `--password <pw>` | Pre-set the password. **Use only in scripts**, never in shell history. Prefer the interactive prompt. |
| `--token-label <s>` | Label for the minted bearer (default: hostname + username). Shown in the dashboard token list. |
| `--project <ref>` | Pin the bearer to a specific project (id or name). Without this, the token is tenant-wide. |
| `--shim-version <ver>` | Pin `@azrtydxb/novamem-mcp` to a specific version. Default: latest. |
| `--skip-shim-check` | Skip the pre-flight that verifies the stdio shim is fetchable + runnable. |
| `--only <host>` | Wire only the named host (e.g. `claude-code`). Repeatable. |
| `--dry-run` | Print every change without writing files. |
| `--non-interactive` | Fail if any input is missing rather than prompting. For CI. |
| `--reset` | Clear the persisted state file (`$XDG_CONFIG_HOME/novamem/init.json`) before starting. |
| `--version` | Print the CLI version and exit. |
| `--help` | Show this list. |

## What happens on first run

1. **Pre-flight check** — verifies `@azrtydxb/novamem-mcp@<version>` is reachable on npm + spawnable. Bails out with an actionable error before touching any config.
2. **Server prompt** — asks for `https://your.novamem` (or `http://localhost:7778`). Probes `/health` to confirm it's reachable.
3. **Auth prompt** — email + password. If the server returns "no users yet", offers to seed the bootstrap admin from the env values.
4. **Token mint** — calls `POST /v1/me/tokens` with the chosen label. Plaintext bearer is shown ONCE in the terminal; only the SHA-256 hash is stored server-side.
5. **Host detection** — scans for each supported tool. Reports what it found.
6. **Config write** — for each detected host, merges the novamem entry into the canonical config file. Preserves existing entries.
7. **Verify** — for stdio hosts, spawns the shim to confirm the wiring works end-to-end before exiting.

## Re-runs

State is persisted at `$XDG_CONFIG_HOME/novamem/init.json` (typically `~/.config/novamem/init.json`):

```json
{
  "lastBaseUrl": "https://novamem.example.com",
  "lastEmail": "alice@example.com"
}
```

These pre-fill prompts on subsequent runs. The token + password are NEVER stored locally.

To start over: `--reset` or delete the file.

## Manual fallback

If your host isn't in the supported list, the CLI prints the JSON snippet you'd otherwise paste — same one for every MCP-compliant client:

```json
{
  "mcpServers": {
    "novamem": {
      "type": "sse",
      "url": "https://your.novamem/mcp/sse",
      "headers": { "Authorization": "Bearer nm_..." }
    }
  }
}
```

For stdio-only hosts, the equivalent stdio shim entry:

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["-y", "@azrtydxb/novamem-mcp@<version>"],
      "env": {
        "NOVAMEM_BASE_URL": "https://your.novamem",
        "NOVAMEM_TOKEN": "nm_..."
      }
    }
  }
}
```

## Troubleshooting

**"Server disconnected" on Claude Desktop after init.** The stdio shim couldn't reach the server. Check:
- The `NOVAMEM_BASE_URL` resolves from your machine.
- The bearer token is still valid (revoked tokens 401).
- Re-run `novamem-init --skip-shim-check` only after fixing the underlying issue.

**EUNSUPPORTEDPROTOCOL when `npx`-ing the shim.** Old novamem-mcp versions had a broken `workspace:*` dep in their tarball. Use `@azrtydxb/novamem-mcp@1.1.3` or newer.

**Init exits silently.** You're on an old Node where `import.meta.url` doesn't normalize symlinks. Upgrade to Node ≥ 20.19.

## See also

- [Claude Code setup](./claude-code.md) — what `.mcp.json` + `commands/` look like
- [Custom HTTP integration](./http.md) — for hosts the CLI doesn't handle
- [API tokens](../dashboard/tokens.md) — manage / revoke tokens after the fact
