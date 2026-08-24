# Decision: how Go-built npx replacements ship

Status: open
Created: 2026-08-20
Epic: mcp-shim-to-go
Sprint: -
Carried: 004-the-installer-speaks-go-and-ships-as-a-binary — docs half needs a channel that does not exist yet — blocked on 20260820-ship-cli-release-binaries; the ADR and the config half both landed

## Description

Host configs and docs invoke `npx @azrtydxb/novamem-mcp`, and the
installer is `npx @azrtydxb/novamem-init` — npx is the zero-install
distribution story. A Go port needs an owner decision: (a) npm packages
that wrap platform Go binaries (npx UX preserved, npm stays a channel),
(b) GitHub-release binaries + install script (npm dropped), or
(c) shim/init stay TS as the one accepted exception. The decision gates
both the shim and init epics and belongs in an ADR.

## Acceptance criteria

- [x] ADR recorded (procoder adr) naming the chosen channel and why
- [ ] init CLI's written host configs match the chosen channel
- [ ] docs-site connect/\* pages match the chosen channel (BLOCKED: needs 20260820-ship-cli-release-binaries — documenting a download that does not exist yet would be worse than the status quo)

## Evidence

- ADR 0001 (GitHub releases + install script; npm dropped) accepted 2026-08-20 — .procoder/adr/0001-go-tool-distribution-via-github-releases.md
