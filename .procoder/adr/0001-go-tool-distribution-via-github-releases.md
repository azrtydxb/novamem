# 0001 — Go tools ship via GitHub releases, not npm

Status: accepted
Date: 2026-08-20

## Context

The full TS→Go migration (backlog milestone full-ts-to-go) ports the MCP
stdio shim (packages/mcp) and the installer CLI (packages/init) to Go.
Today their entire distribution story is `npx @azrtydxb/novamem-mcp` and
`npx @azrtydxb/novamem-init` — zero-install, but it drags a Node runtime
into every AI-host machine and keeps npm as a release channel for a
project whose runtime is otherwise a single static Go binary.

## Decision

Go-built tools are distributed as GitHub-release binaries (per-platform,
same goreleaser flow the server already uses) plus an install script.
npm is dropped as a channel for the shim and installer. Rejected:
npm packages wrapping Go binaries (keeps npx UX but keeps npm publishing,
postinstall binary downloads are a known fragility/security smell) and
keeping shim+init in TS (leaves Node on every host machine and two
runtimes to maintain — the thing the migration exists to end).

## Consequences

Easier: one artifact kind (binaries) and one release flow for all Go
tools; no Node needed on machines that only run agents; supply-chain
surface shrinks to GitHub releases. Harder: every host config the init
CLI writes, every docs-site connect/\* page, and the getting-started flow
must switch from `npx …` to a binary path; existing installs keep
working but new-install docs change; the Changesets/npm release
machinery (release-preflight.mjs, linked-version config) loses its
purpose once the client deprecation (ADR 0002) lands and should be
retired with it.
