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

- scripts/doc-smoke.mjs — zero-dependency build-time CI gate; Node is
  already in the toolchain for the docs-site and admin-ui builds
  (recorded by 20260820-repo-scripts-disposition, 2026-08-20).
