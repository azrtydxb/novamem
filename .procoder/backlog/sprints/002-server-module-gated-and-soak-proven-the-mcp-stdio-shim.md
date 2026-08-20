# Server module gated and soak-proven; the MCP stdio shim ported to Go

Status: active
Created: 2026-08-20

## Goal

The go/ module reaches the same lint bar as clients/go and CI enforces
it; the last unconfirmed parity-audit fix (BumpHitsMany) is proven under
a concurrent-search soak; and the first ADR-gated port lands — a Go
stdio MCP shim whose tool surface byte-matches the TS shim, leaving
packages/mcp ready for deletion once hosts are switched.
