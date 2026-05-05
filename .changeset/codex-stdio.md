---
"@azrtydxb/novamem-init": patch
"@azrtydxb/novamem-mcp": patch
---

fix(init): correct MCP transport for hosts with broken SSE paths

Following the Codex-CLI handshake bug, audited every host the
installer configures. Three fixes shipped together:

1. **Codex CLI** — its MCP client speaks Streamable HTTP, not SSE.
   Pointing it at `/mcp/sse` produced "Deserialize error: data did
   not match any variant of untagged enum JsonRpcMessage". Routed
   through the `@azrtydxb/novamem-mcp` stdio shim.

2. **OpenCode** — confirmed broken: its remote-MCP path rejects
   SSE servers (sst/opencode#834) and Streamable HTTP isn't shipped
   yet (#8058). Plus its config schema differs from every other
   host — top-level `mcp` (not `mcpServers`), stdio entries shaped
   `{type: "local", command, args, environment}` (not `env`).
   Extended `McpAdapter` with `stdioEnvKey` + `stdioTypeField`
   to model this without per-host special cases in buildMcpEntry.

3. **Gemini CLI** — the SSE path historically dropped `Authorization`
   headers (google-gemini/gemini-cli#2427); the fix (#13762) shipped
   but older installs still strip our bearer and the server 401s.
   Routed through the stdio shim — env vars are guaranteed-forwarded
   regardless of CLI version.

Other hosts audited and confirmed correct as-is: Claude Code, Claude
Desktop, Cursor (with a pinned watch on cursor.com forum #154390),
Kilo Code (auto-falls-back), GitHub Copilot.

73/73 init tests pass; new tests assert the OpenCode + Gemini
shapes explicitly.
