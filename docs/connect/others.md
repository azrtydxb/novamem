# Other clients + the Skills add-on

Two routes for hosts not covered by a dedicated guide:

1. **MCP** — connect to the server’s `/mcp` endpoint from any remote MCP client
2. **Agent Skills** — a markdown bundle compatible with [agentskills.io](https://agentskills.io), for clients that prefer skills over MCP (or want both)

## Configure a host

Install the Go CLI binaries using the [release installer](../contribute/releases.md#installing) and run `novamem-init` to detect and configure supported hosts. For a manual setup, add the endpoint and bearer shown below.

## MCP — generic config

### Remote MCP (recommended)

For any host that supports remote MCP over SSE:

```json
{
  "mcpServers": {
    "novamem": {
      "type": "http",
      "url": "http://localhost:7778/mcp",
      "headers": { "Authorization": "Bearer nm_..." }
    }
  }
}
```

Confirmed working with: Claude Code, Claude Desktop, Cursor, Kilo Code, Goose, OpenCode, Continue (recent builds), Cline, Roo Code.

The Go installer configures hosts that require stdio with the `novamem-mcp` binary shipped alongside `novamem-init`. For hosts that support remote MCP, use `/mcp` directly as above.

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
2. Configure the host to use the server’s `/mcp` endpoint. The Go installer handles hosts that require stdio.
4. Optionally drop the Skills bundle in the client's skills directory for richer behaviour rules.
5. If your client speaks neither MCP nor Skills, use the [HTTP API](../api/index.md) directly — the OpenAPI spec covers every operation.

If you wire up a new client, a PR adding it to this directory is welcome.
