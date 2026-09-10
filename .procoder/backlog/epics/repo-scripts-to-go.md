# Repo scripts off Node

Status: open
Created: 2026-08-20
Milestone: full-ts-to-go--everything-but-the-web-ui

## Description

Three live .mjs ops scripts remain (doc-smoke, release-preflight,
sync-qdrant-to-pgvector; gen-runtime-package.mjs is dead and dies with
the cleanup epic). Small, node-invoked, judgment per script: port to Go,
or record that build-time Node tooling is acceptable since the docs-site
and admin-ui builds keep Node in the toolchain anyway.
