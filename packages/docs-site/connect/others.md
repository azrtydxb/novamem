# Other clients + the Skills add-on

Two routes for hosts not covered by a dedicated guide:

1. **MCP** — the same SSE / stdio shim works for any MCP-compliant client
2. **Agent Skills** — a markdown bundle compatible with [agentskills.io](https://agentskills.io), for clients that prefer skills over MCP (or want both)

## One-shot installer (try this first)

```bash
npx @azrtydxb/novamem-init
```

Detects 30+ AI hosts (Claude Code/Desktop, Cursor, Kilo Code, OpenCode, Codex CLI, Gemini CLI, Copilot, Cline, RooCode, Continue, Factory, Windsurf, Amazon Q, plus 16 skill-only hosts) and wires up whatever it finds — MCP config, skill bundle, slash commands. Idempotent. Skip ahead only if your host isn't in that list or you want to script it.

## MCP — generic config

### Direct SSE (recommended)

For any host that supports remote MCP over SSE:

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

Confirmed working with: Claude Code, Claude Desktop, Cursor, Kilo Code, Goose, OpenCode, Continue (recent builds), Cline, Roo Code.

### Stdio shim (legacy)

For hosts that only speak stdio MCP, the [@azrtydxb/novamem-mcp](https://www.npmjs.com/package/@azrtydxb/novamem-mcp) shim bridges stdio↔HTTP:

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

Same current NovaMem MCP tool surface (`memory_*` + `project_*`).

## Agent Skills add-on

If your client supports the [Agent Skills](https://agentskills.io) format — Goose, OpenCode, OpenHands, Junie, Roo Code, Factory, and a growing list — you can drop the bundled skill into the client's skills directory **alongside** or **instead of** the MCP server.

The skill teaches the agent _when_ to call the tools and _how_ to phrase saves; MCP exposes the tools themselves. With both, the skill loads at startup (\~100 tokens for `name` + `description`), expands on demand, and the agent calls `memory_*` / `project_*` over MCP.

### Layout

The bundle lives at [`skills/novamem/`](https://github.com/azrtydxb/novamem/tree/main/skills/novamem) and follows the agentskills.io spec:

```
skills/novamem/
├── SKILL.md                 # name, description, when-to-use rules
└── references/
    ├── search.md            # memory_search / recent / today / neighbors / stats
    ├── remember.md          # memory_capture / remember / update / forget + worthiness gate
    └── projects.md          # all 7 project_* tools
```

### Install

Most clients want a copy or symlink under `<workspace>/skills/` or `~/.config/<agent>/skills/`. Examples:

```bash
# Goose
cp -r skills/novamem ~/.config/goose/skills/

# OpenCode (project-scoped)
cp -r skills/novamem .opencode/skills/

# Generic — symlink works for any client that scans a skills dir
ln -s "$(pwd)/skills/novamem" ~/.skills/novamem
```

Check your client's docs for the exact path — the [agentskills.io client list](https://agentskills.io/clients) links each one.

### Validate

```bash
npx -y skills-ref validate ./skills/novamem
```

This checks the SKILL.md frontmatter and naming conventions.

## Build your own integration

For a host without dedicated docs:

1. Mint a `nm_…` bearer from the dashboard's API Tokens page.
2. Try the SSE config first — that works for any modern MCP host.
3. Fall back to the stdio shim if SSE isn't supported.
4. Optionally drop the Skills bundle in the client's skills directory for richer behaviour rules.
5. If your client speaks neither MCP nor Skills, use the [HTTP API](../api/index.md) directly — the OpenAPI spec covers every operation.

If you wire up a new client, a PR adding it to this directory is welcome.
