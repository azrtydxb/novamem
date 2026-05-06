# @azrtydxb/novamem-mcp

## 1.2.1

### Patch Changes

- 185a306: fix(init): correct MCP transport for hosts with broken SSE paths

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

## 1.2.0

### Minor Changes

- 14eed8a: `@azrtydxb/novamem-init` now pre-flights the stdio shim and remembers your last base URL + email.

  **Pinned shim version.** Stdio configs we write now point at `@azrtydxb/novamem-mcp@<this-init-version>` (e.g. `@1.1.4` not floating "latest"). Reproducible: an init at `1.1.4` always pairs with the matching shim. Changesets bumps both packages from one changeset, so the pinned version always exists on npm.

  **Pre-flight check.** Before writing a stdio config, init now runs `npm view @azrtydxb/novamem-mcp@<v> dependencies` (asserts no leftover `workspace:` protocol values) and spawns the shim briefly (asserts it doesn't crash on startup). If either fails, init aborts with a clear message instead of writing a config that produces "Server disconnected" on first launch. Pass `--skip-shim-check` to override.

  This is the check that would have caught v0.1.0–1.1.2's `workspace:*` outage on day one — every published shim had unresolvable `"@azrtydxb/novamem": "workspace:*"` deps that npm/npx silently failed to install.

  **Persistent state.** Successful runs now save `{ lastBaseUrl, lastEmail }` to `$XDG_CONFIG_HOME/novamem/init.json` (default `~/.config/novamem/init.json`). The next interactive run pre-fills those values as the default for the prompts. Tokens are NEVER stored — they're auth material. Best-effort: silently no-ops on a read-only home.

## 1.1.3

### Patch Changes

- a0a2c20: Republish to fix the `workspace:*` dependency that npm/npx couldn't resolve.

  Every published version of `@azrtydxb/novamem-mcp` since v0.1.0 declared
  `"@azrtydxb/novamem": "workspace:*"` in `dependencies`. `npm install` and
  `npx @azrtydxb/novamem-mcp` both error out with `EUNSUPPORTEDPROTOCOL:
workspace:` before the binary even starts — Claude Desktop sees the
  spawn die instantly and shows "MCP novamem: Server disconnected".

  Why: the prior release workflow ran `npm publish` directly, which
  doesn't rewrite `workspace:*` in published tarballs. `pnpm publish`
  (now used by the Changesets workflow) DOES rewrite it to the actual
  version. Bumping all three publishables a patch level forces a clean
  republish through the new flow.

- Updated dependencies [a0a2c20]
  - @azrtydxb/novamem@1.1.3
