# @azrty/novamem-mcp

MCP-stdio shim + login helper for [novamem](https://github.com/azrtydxb/novamem). Wraps a remote novamem server's tools so any MCP-aware host (Claude Desktop, Cursor, Cline, Claude Code) can use them.

```bash
npx @azrty/novamem-mcp
```

## MCP shim

Configure your MCP host:

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azrty/novamem-mcp"],
      "env": {
        "NOVAMEM_BASE_URL": "http://localhost:7778",
        "NOVAMEM_TOKEN": "nm_…"
      }
    }
  }
}
```

### Tools advertised

- `memory.search` / `memory.remember` / `memory.recent` / `memory.today` / `memory.neighbors` / `memory.forget` / `memory.stats` — every tool accepts an optional `project` argument.
- `project.list` / `project.create` — **require a session bearer (`ns_…`)**, not a tenant token. Use `novamem-login` (below) to get one.

### Bearer flavors

- **Tenant-wide token (`nm_…` minted without projectId)** — sees only tenant-wide entries.
- **Project-scoped token (`nm_…` minted with projectId)** — sees only that project. Project is the default for `memory.*`; passing a different `project` argument returns 403.
- **Session bearer (`ns_…`)** — full user-scoped surface; required for `project.create`/`project.list`.

## `novamem-login` helper

Trades username + password for a session token suitable for `NOVAMEM_TOKEN`:

```bash
# Interactive (prompts for password on a TTY)
NOVAMEM_USERNAME=bob npx -p @azrty/novamem-mcp novamem-login

# Non-interactive (CI / scripts)
SESSION=$(NOVAMEM_USERNAME=bob NOVAMEM_PASSWORD=… npx -p @azrty/novamem-mcp novamem-login)
NOVAMEM_TOKEN=$SESSION npx @azrty/novamem-mcp
```

Output:
- **stdout** — the bare session token (suitable for `$(...)`).
- **stderr** — a one-line banner describing the user + expiry.

Env vars:
- `NOVAMEM_BASE_URL` (default `http://localhost:7778`)
- `NOVAMEM_USERNAME` (or first positional arg)
- `NOVAMEM_PASSWORD` (optional; falls back to TTY prompt with no-echo)

## End-to-end skill flow

```bash
# 1. Log in (or load a saved session)
SESSION=$(NOVAMEM_USERNAME=bob npx -p @azrty/novamem-mcp novamem-login)

# 2. Boot the MCP shim with the session bearer; project.create/list are now available
NOVAMEM_TOKEN=$SESSION npx @azrty/novamem-mcp
# (your MCP host now sees the full novamem tool surface)

# 3. Inside the session, mint a long-lived project token via the dashboard or:
#    curl -X POST http://localhost:7778/v1/me/tokens \
#      -H "authorization: Bearer $SESSION" \
#      -H "content-type: application/json" \
#      -d '{"projectId":"phoenix","label":"this-laptop"}'
#    Then swap NOVAMEM_TOKEN to that nm_… and stop using the session.
```

## See also

- [SECURITY.md](https://github.com/azrtydxb/novamem/blob/main/SECURITY.md) — auth model and hardening checklist.
- Main repo for the OpenAPI spec, dashboard, and HTTP API.
