# Go installer CLI

Status: done 2026-08-21
Created: 2026-08-20
Epic: init-cli-to-go
Sprint: 004-the-installer-speaks-go-and-ships-as-a-binary

## Description

Port packages/init to Go: interactive sign-in against a novamem server,
token mint, host detection (the ~30 supported AI hosts), and writing MCP
configs / skill bundles / slash commands per host. Blocked by the
distribution ADR. The regression bar is the TS package's own test suite
(packages/init/test) translated, since those tests encode host-config
bugs already fixed once (e.g. the Claude Desktop stdio-only regression
in CHANGELOG 1.1.2).

## Acceptance criteria

- [x] every host adapter the TS CLI supports produces byte-equivalent config output in the Go CLI (fixture-diffed)
- [x] the 1.1.2 Claude-Desktop-stdio regression test exists in the Go port
- [x] interactive flow (sign-in, token mint, host pick) verified — auth against httptest, the CLI end to end against a local HTTP target
- [x] distribution per the ADR — the CLI writes ADR-0001 shapes (stdio entries name the binary; `--mcp-bin` / `NOVAMEM_MCP_BIN` resolve it)

SCOPE MOVED, not dropped: this story originally also carried "docs
updated". Shipping the channel and rewriting the docs turned out to need
their own work, now owned by 20260820-ship-cli-release-binaries (build
and attach the binaries + install script) and by the docs criterion of
20260820-mcp-shim-distribution-decision, which is blocked on it.
Documenting a download that does not exist yet would be worse than the
status quo, so neither is silently closed here.

## Evidence

- PARITY MEASURED, not reviewed. testdata/golden.json records what the TypeScript installer actually wrote for all 30 hosts (generated from it before retirement; provenance in testdata/README.md). Against it:
  - registry: a field-for-field dump of both registries is IDENTICAL, in order (30 entries, every id/scope/skillsBase/detect/mcp/commands field)
  - MCP configs: all 8 MCP hosts match — 7 JSON byte-for-byte, Codex TOML semantically (go-toml and smol-toml disagree on quoting and table order, which neither host nor user can observe; structure and preservation are the contract)
  - slash commands: 54 files across the 6 command-capable hosts, byte-for-byte, all four render formats
  - merge behaviour is pinned, not just fresh writes: the fixture and the test both install into a config that already holds a foreign server plus an unrelated top-level key, and assert order and content survive; a second run is asserted to be a no-op
- The ONE sanctioned difference is applied to the EXPECTATION, never to the fixture: per ADR 0001 stdio entries name the shipped novamem-mcp binary and drop `args`. The test fails loudly if a stdio fixture stops looking like the npx form it replaces, so the substitution cannot silently become a no-op.
- Key order is load-bearing and Go's encoding/json sorts map keys, so the port carries an ordered JSON document; all 7 JSON fixtures round-trip through it byte-for-byte.
- The skill bundle and command sources are embedded (go:embed) so the binary is self-contained, with a drift test failing when they diverge from skills/novamem/ and integrations/claude-code/commands/ — the same tripwire this repo uses for openapi.json.
- The npm pre-flight became a binary pre-flight: same bug class (never write a config pointing at a shim that cannot start), new channel. Verified live — the CLI refused nothing and reported "Shim ready" against the real novamem-mcp binary.
- End-to-end run against a local HTTP target wrote 20 files: SSE entry for Claude Code, stdio entry naming the binary for Claude Desktop, 9 command files, skill bundles. go build/test/vet green; golangci-lint 0 issues across the module.
- NOT deleted: packages/init stays until the ADR-0002 deprecation version publishes (that ordering is owned by 20260820-retire-npm-release-machinery). Shipping the Go binary is 20260820-ship-cli-release-binaries.
