# Retire the npm release machinery (consequence of ADR 0001+0002)

Status: open
Created: 2026-08-20
Epic: client-library-go-parity
Sprint: -

## Description

With the shim and installer moving to GitHub releases (ADR 0001) and the
TS client deprecated (ADR 0002), nothing publishes to npm any more. The
Changesets config (linked init+mcp versions), release-preflight.mjs, the
npm badges on the README, and any release workflow steps that publish to
npm all lose their purpose and must be removed deliberately — after the
final deprecation versions are published, not before.

## Acceptance criteria

- [ ] final versions of client/mcp/init published with deprecation notices (ordering: this happens first)
- [ ] .changeset config, release-preflight.mjs, and npm publish steps removed from workflows and package.json
- [ ] README npm badges removed; docs-site install/connect pages no longer reference npx/npm for these tools
- [ ] project_release_flow memory/docs updated: GitHub releases are the only channel

## Evidence

