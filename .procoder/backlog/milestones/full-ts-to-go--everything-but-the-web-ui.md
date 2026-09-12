# Full TS→Go — everything but the web UI

Status: open
Created: 2026-08-20

## Goal

Every runtime component is Go except the browser-delivered UIs
(packages/admin-ui Preact dashboard, packages/docs-site VitePress).
The npm packages (client, mcp shim, init CLI), the benchmarks harness,
and the repo scripts either have Go replacements shipped and adopted, or
a written owner decision records why they stay TS/JS. NOTE: this
milestone deliberately supersedes the 2026-08-13 spec's non-goal
("client / mcp / init stay TypeScript permanently") — owner decision
2026-08-20, this conversation.

## Accepted exceptions

- ~~scripts/doc-smoke.mjs~~ — **superseded 2026-09-12; ported to
  go/cmd/doc-smoke.** The exception rested on the gate being
  zero-dependency and Node already being in the toolchain. Both premises
  went: the checks now compare documentation against Go sources of truth
  (the config registry, tooldefs.json, the generated OpenAPI document),
  which a Node script can only reach by holding a second copy of them.
  Wiring the first such check up made `pnpm docs:smoke` shell into Go and
  broke the Node-only CI job twice. Parity verified across 11 injected
  violations: byte-identical findings from both implementations.
