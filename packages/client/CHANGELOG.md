# @azrtydxb/novamem

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
