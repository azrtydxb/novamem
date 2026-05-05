---
"@azrtydxb/novamem-init": patch
"@azrtydxb/novamem-mcp": patch
---

fix(init): use stdio shim for OpenAI Codex CLI

Codex CLI's MCP client speaks Streamable HTTP; novamem only exposes
the legacy SSE transport at /mcp/sse. Configuring Codex with
transport=sse caused a cryptic handshake failure on first start:

  Deserialize error: data did not match any variant of untagged enum
  JsonRpcMessage, when send initialize request

Switch Codex to the stdio shim (`@azrtydxb/novamem-mcp`) — same
fix as Claude Desktop. The shim proxies stdio↔SSE internally so it
works regardless of what HTTP transport the host expects.
