---
"@azrtydxb/novamem-init": minor
"@azrtydxb/novamem-mcp": minor
---

`@azrtydxb/novamem-init` now pre-flights the stdio shim and remembers your last base URL + email.

**Pinned shim version.** Stdio configs we write now point at `@azrtydxb/novamem-mcp@<this-init-version>` (e.g. `@1.1.4` not floating "latest"). Reproducible: an init at `1.1.4` always pairs with the matching shim. Changesets bumps both packages from one changeset, so the pinned version always exists on npm.

**Pre-flight check.** Before writing a stdio config, init now runs `npm view @azrtydxb/novamem-mcp@<v> dependencies` (asserts no leftover `workspace:` protocol values) and spawns the shim briefly (asserts it doesn't crash on startup). If either fails, init aborts with a clear message instead of writing a config that produces "Server disconnected" on first launch. Pass `--skip-shim-check` to override.

This is the check that would have caught v0.1.0–1.1.2's `workspace:*` outage on day one — every published shim had unresolvable `"@azrtydxb/novamem": "workspace:*"` deps that npm/npx silently failed to install.

**Persistent state.** Successful runs now save `{ lastBaseUrl, lastEmail }` to `$XDG_CONFIG_HOME/novamem/init.json` (default `~/.config/novamem/init.json`). The next interactive run pre-fills those values as the default for the prompts. Tokens are NEVER stored — they're auth material. Best-effort: silently no-ops on a read-only home.
