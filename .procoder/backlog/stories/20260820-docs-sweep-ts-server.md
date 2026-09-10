# Docs sweep for TS-server references

Status: done 2026-08-20
Created: 2026-08-20
Epic: spec-cleanup-phase
Sprint: -

## Description

User-facing docs must describe the Go server as the only server; the
spec's cleanup phase ends with a docs sweep.

## Acceptance criteria

- [x] no docs page describes packages/server as a live component
- [x] remaining mentions are historical (migration audit, changelog, "this replaced" prose)

## Evidence

- `grep -rln "packages/server" docs/ packages/docs-site --include='*.md'` (2026-08-20) → go-parity-audit.md, conformance-suite plan, migration spec (all historical documents), docs-site contribute/layout.md ("The TypeScript server this replaced … was removed"), reference/changelog.md (release-notes history). None present it as live.
