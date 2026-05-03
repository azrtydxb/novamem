# NovaMem agent integrations

Drop-in configs that wire NovaMem's MCP server, behaviour rules, and slash
commands into AI coding agents (Claude Code, Kilo Code, Cursor, …) so the
agent uses long-term memory consistently across sessions.

## Layout

```
claude-code/   .mcp.json + CLAUDE.md + .claude/commands/* — copy or symlink into your project root
kilo-code/     same content reshaped for Kilo Code's .kilocode/ layout
```

Both directories install a `novamem` MCP server that talks to a running
NovaMem instance over HTTP, plus a set of slash commands (`/remember`,
`/recall`, `/today`, …) and a rules file the agent loads automatically.

## Prerequisites

- A NovaMem service reachable from your machine (default
  `http://localhost:7778` from `docker compose up`).
- A bearer token (`nm_…`). Mint via the dashboard at
  `http://localhost:7778/admin` → API tokens, or the CLI helper
  `pnpm dlx @azrty/novamem-mcp novamem-login`.

## Install — Claude Code

From your project root:

```bash
# Drop the config files into your repo
cp /path/to/novamem/integrations/claude-code/.mcp.json ./
mkdir -p .claude/commands
cp -r /path/to/novamem/integrations/claude-code/commands/. .claude/commands/

# Append the rules block to your CLAUDE.md (or create one)
cat /path/to/novamem/integrations/claude-code/CLAUDE.md >> CLAUDE.md
```

Then export your bearer in the env Claude Code launches MCP servers in
(or set it inline in `.mcp.json` — see file). Restart Claude Code.

## Install — Kilo Code

Same idea against `.kilocode/`. See `kilo-code/README.md` for the exact
paths.

## Using it

After install, from any session:

| Command       | Does                                                                  |
| ------------- | --------------------------------------------------------------------- |
| `/remember …` | Store a memory entry (decision, preference, constraint, fact).        |
| `/recall …`   | Hybrid search (keyword + vector + graph). Returns top 10.             |
| `/today`      | Activity feed for the last 24h.                                       |
| `/recent`     | Newest entries in a namespace.                                        |
| `/forget id`  | Hard delete across warm + cold + graph.                               |
| `/neighbors`  | Graph-neighbour traversal from a seed entry id.                       |
| `/projects`   | List sub-brain projects you can access.                               |

The rules file (`CLAUDE.md` fragment) tells the agent:

- when to call `memory.remember` (durable info, not transient state)
- when to call `memory.search` (before exploring the codebase, when the
  user references prior work, when a decision was likely already made)
- how to use weights (`{ keyword: 1 }` for ids/symbols, default for prose)
- how project scope works (omit for user-wide, set for sub-brain)
