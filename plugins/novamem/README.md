# NovaMem plugin for Claude Code

Long-term memory for Claude Code, backed by a NovaMem server you run.

- **MCP server** `novamem`, over streamable HTTP at `<server>/mcp`. You don't need a shim binary or Node.
- **Skills**: `novamem` (when and how to use each memory tool) and
  `session-recap` (save what's worth keeping before you close a session).
- **Slash commands**: `/remember`, `/recall`, `/today`, `/recent`,
  `/forget`, `/neighbors`, `/projects`, `/project-create`, `/memory-stats`.

## Install

```
/plugin marketplace add azrtydxb/novamem
/plugin install novamem@novamem
```

When you enable the plugin, Claude Code asks for:

| Option     | What                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| `base_url` | Your NovaMem server, without `/mcp`. Default `http://localhost:7778`.                 |
| `token`    | An `nm_…` bearer from `<server>/admin` → API Tokens. Kept in the OS credential store. |

Change them later with `/plugin configure novamem@novamem`.

Check it with `/mcp`. The server is listed as `plugin:novamem:novamem`.

## Editing

Don't edit `commands/` or `skills/` here. They're generated copies:

| Here             | Source of truth                      |
| ---------------- | ------------------------------------ |
| `skills/<name>/` | `skills/<name>/` at the repo root    |
| `commands/`      | `integrations/claude-code/commands/` |

Plugin tool names are namespaced (`mcp__plugin_novamem_novamem__…`), so
the copy rewrites `mcp__novamem__` references in commands. Re-sync with:

```bash
cd go && go run ./cmd/gen-contract
```

CI regenerates the copies and fails if they differ from what's committed.
`claude plugin validate . --strict` from the repo root checks the
marketplace and `claude plugin validate plugins/novamem --strict` checks the plugin.
