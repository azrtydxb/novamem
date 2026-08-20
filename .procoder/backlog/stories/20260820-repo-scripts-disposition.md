# Disposition of the three live .mjs scripts

Status: open
Created: 2026-08-20
Epic: repo-scripts-to-go
Sprint: -

## Description

scripts/doc-smoke.mjs (docs link smoke), scripts/release-preflight.mjs
(npm release gate), scripts/sync-qdrant-to-pgvector.mjs (one-shot data
migration tool). Per script: port to Go, delete as obsolete (the qdrant
sync may already be spent), or record as accepted build-time Node
tooling. release-preflight's fate follows the npm-package decisions —
if npm publishing stays, its gate stays.

## Acceptance criteria

- [ ] each of the three scripts has a recorded disposition (ported / deleted / kept with reason)
- [ ] anything deleted is removed from package.json scripts and docs
- [ ] anything kept is named in the milestone goal's accepted-exceptions list

## Evidence

