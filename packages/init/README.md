# @azrty/novamem-init

Interactive installer that wires every supported AI agent host on your machine to a [novamem](https://github.com/azrtydxb/novamem) server in one command.

```bash
npx @azrty/novamem-init
```

It will:

1. Ask for the novamem server URL (default `http://localhost:7778`)
2. Ask for your dashboard email + password
3. Sign in via Better Auth, mint a fresh `nm_…` bearer (auto-labelled `novamem-init@<hostname>`)
4. Detect installed AI tools and show a multi-select (detected ones pre-checked)
5. For each chosen tool, write:
   - the **skill bundle** (`<host>/skills/novamem/`) — every tool gets this
   - an **MCP server entry** (SSE for modern hosts) — into the host's config file, JSON-merged so existing servers aren't clobbered
   - **slash commands** (where applicable) — re-rendered into the host's expected format

The session cookie and password are discarded immediately; only the minted bearer ends up on disk.

## Supported tools

30 hosts taken from the [agentskills.io](https://agentskills.io) ecosystem (mirrors OpenSpec's inventory):

**Full support** (skill + MCP + slash commands): Claude Code · Claude Desktop · Cursor · Kilo Code · OpenCode · GitHub Copilot · Gemini CLI · OpenAI Codex CLI

**Skill + slash commands**: RooCode · Cline · Continue · Factory Droid · Windsurf · Amazon Q Developer

**Skill-only** (the rest of the OpenSpec list): Antigravity · Auggie · Bob · CodeBuddy · CoStrict · Crush · ForgeCode · iFlow · Junie · Kimi CLI · Kiro · Lingma · Pi · Qoder · Qwen Code · Trae

## Flags

For non-interactive use (CI, automation):

```bash
novamem-init \
  --base-url http://localhost:7778 \
  --token nm_... \
  --tools claude-code,cursor,codex \
  --yes
```

| Flag | Env | Purpose |
|---|---|---|
| `--base-url <url>` | `NOVAMEM_BASE_URL` | Server URL — skip the prompt |
| `--email <email>` | — | Dashboard email — skip the prompt |
| `--password <pwd>` | `NOVAMEM_PASSWORD` | Dashboard password — skip the prompt |
| `--token <nm_…>` | `NOVAMEM_TOKEN` | Use an existing bearer; skip sign-in entirely |
| `--tools <ids>` | — | Comma-separated tool ids (`claude-code,cursor,…`) |
| `--all` | — | Configure every tool in the registry |
| `-y, --yes` | — | Non-interactive mode (auto-confirm + use detected tools) |
| `--dry-run` | — | Print what would happen; write nothing |

## Idempotency

Re-running the installer is safe — every config write is a JSON/TOML merge that preserves existing keys. If your `novamem` entry already matches what we'd write, the file is left alone.

## What gets written where

| Tool | MCP config | Skills | Commands |
|---|---|---|---|
| Claude Code | `<cwd>/.mcp.json` | `<cwd>/.claude/skills/novamem/` | `<cwd>/.claude/commands/` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/.claude/skills/novamem/` | — |
| Cursor | `<cwd>/.cursor/mcp.json` | `<cwd>/.cursor/skills/novamem/` | `<cwd>/.cursor/commands/` |
| Kilo Code | `<cwd>/.kilocode/mcp.json` | `<cwd>/.kilocode/skills/novamem/` | `<cwd>/.kilocode/workflows/` |
| OpenCode | `<cwd>/.opencode/opencode.json` | `<cwd>/.opencode/skills/novamem/` | `<cwd>/.opencode/commands/` |
| Codex CLI | `~/.codex/config.toml` (TOML, `[mcp_servers.novamem]`) | `~/.codex/skills/novamem/` | `~/.codex/prompts/memory-*.md` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/skills/novamem/` | `~/.gemini/commands/*.toml` |
| GitHub Copilot | `<cwd>/.mcp.json` | `<cwd>/.github/skills/novamem/` | `<cwd>/.github/prompts/*.prompt.md` |
| Continue | — | `<cwd>/.continue/skills/novamem/` | `<cwd>/.continue/prompts/*.prompt` |
| Cline | — | `<cwd>/.cline/skills/novamem/` | `<cwd>/.clinerules/workflows/` |
| RooCode | — | `<cwd>/.roo/skills/novamem/` | `<cwd>/.roo/commands/` |
| Factory | — | `<cwd>/.factory/skills/novamem/` | `<cwd>/.factory/commands/` |
| Windsurf | — | `<cwd>/.windsurf/skills/novamem/` | `<cwd>/.windsurf/workflows/` |
| Amazon Q | — | `<cwd>/.amazonq/skills/novamem/` | `<cwd>/.amazonq/prompts/memory-*.md` |
| Skill-only hosts | — | `<cwd>/<base>/skills/novamem/` | — |

## What it does NOT do

- It doesn't manage the server — install it separately (`docker compose up -d`, k3s, etc.)
- It doesn't install tools you don't already have — it only configures hosts whose convention dirs exist (or are forced via `--all`)
- It doesn't manage your bearer's lifecycle — revoke from the dashboard's API Tokens page when done

## See also

- [novamem README](https://github.com/azrtydxb/novamem) — the server
- [docs/connect/](https://github.com/azrtydxb/novamem/tree/main/docs/connect) — manual config snippets per host
