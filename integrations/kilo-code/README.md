# NovaMem on Kilo Code

Kilo Code (https://kilocode.ai) reads project-scoped rules and slash
commands from `.kilocode/`. The structure mirrors Claude Code's, so the
same content from `../claude-code/` works with three small tweaks.

## Install

From your project root:

```bash
mkdir -p .kilocode/rules .kilocode/commands

# Rules block — drop into the rules folder so Kilo loads it.
cp /path/to/novamem/integrations/claude-code/CLAUDE.md \
   .kilocode/rules/novamem.md

# Slash commands map 1:1.
cp /path/to/novamem/integrations/claude-code/commands/*.md \
   .kilocode/commands/

# MCP server config goes in Kilo's MCP json. Either copy the .mcp.json
# verbatim into your project root (Kilo respects the same file Claude
# Code does) or paste the `mcpServers.novamem` block into your existing
# .kilocode/mcp.json.
cp /path/to/novamem/integrations/claude-code/.mcp.json ./
```

Set `NOVAMEM_TOKEN` in the env Kilo launches MCP servers under, then
restart.

## Notes

- The `allowed-tools: mcp__novamem__memory_remember` frontmatter line in
  each command works the same in Kilo (Kilo derives the tool name from
  the MCP server name + tool name, separator `__`).
- Both editors look at `~/.claude/CLAUDE.md` and project-root
  `CLAUDE.md`, so if you'd rather have NovaMem rules globally, append
  the `claude-code/CLAUDE.md` block to `~/.claude/CLAUDE.md` instead of
  copying it per-project.
