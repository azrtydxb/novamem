# Go installer CLI

Status: open
Created: 2026-08-20
Epic: init-cli-to-go
Sprint: -

## Description

Port packages/init to Go: interactive sign-in against a novamem server,
token mint, host detection (the ~30 supported AI hosts), and writing MCP
configs / skill bundles / slash commands per host. Blocked by the
distribution ADR. The regression bar is the TS package's own test suite
(packages/init/test) translated, since those tests encode host-config
bugs already fixed once (e.g. the Claude Desktop stdio-only regression
in CHANGELOG 1.1.2).

## Acceptance criteria

- [ ] every host adapter the TS CLI supports produces byte-equivalent config output in the Go CLI (fixture-diffed)
- [ ] the 1.1.2 Claude-Desktop-stdio regression test exists in the Go port
- [ ] interactive flow (sign-in, token mint, host pick) verified against a live server
- [ ] distribution per the ADR; docs updated

## Evidence

