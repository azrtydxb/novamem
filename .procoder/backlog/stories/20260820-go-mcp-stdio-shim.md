# Go MCP stdio shim binary

Status: open
Created: 2026-08-20
Epic: mcp-shim-to-go
Sprint: 002-server-module-gated-and-soak-proven-the-mcp-stdio-shim

## Description

A Go binary (novamem-mcp, or a subcommand of the server binary) that
speaks MCP over stdio and bridges to a novamem server's streamable-HTTP
endpoint, replacing packages/mcp. Must reproduce the shim's current
behaviour: env-driven config (URL, token, project), all 21 tools passed
through, reconnect/backoff, and the prompt text packages/mcp injects.

## Acceptance criteria

- [ ] stdio handshake + tools/list against the shim matches the TS shim byte-for-byte on tool schemas (21 tools)
- [ ] conformance MCP suite passes when driven through the Go shim
- [ ] Claude Desktop (stdio-only host) works end-to-end against it
- [ ] same env vars honored as the TS shim documents

## Evidence

