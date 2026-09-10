# Port the MCP stdio shim (packages/mcp) to Go

Status: open
Created: 2026-08-20
Milestone: full-ts-to-go--everything-but-the-web-ui

## Description

packages/mcp (~980 LOC TS) bridges stdio MCP clients to the server's
streamable-HTTP endpoint. The Go server already speaks MCP server-side
(go/internal/mcp); the shim is a small client-side bridge and the last
piece of TS between an AI host and the server. Every host config the
init CLI writes today invokes `npx @azrtydxb/novamem-mcp`.
