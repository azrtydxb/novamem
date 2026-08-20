# Port the installer CLI (packages/init) to Go

Status: open
Created: 2026-08-20
Milestone: full-ts-to-go--everything-but-the-web-ui

## Description

packages/init (~2,563 LOC TS) is the interactive installer: signs in,
mints a token, detects installed AI hosts, writes MCP configs + skill
bundles + slash commands. Largest remaining TS runtime. Its whole UX is
`npx @azrtydxb/novamem-init`, so the port stands or falls on the
distribution decision (see its decision story).
