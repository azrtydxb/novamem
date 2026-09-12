# Disposition of the three live .mjs scripts

Status: done 2026-08-20
Created: 2026-08-20
Epic: repo-scripts-to-go
Sprint: 003-the-conformance-oracle-speaks-go

## Description

scripts/doc-smoke.mjs (docs link smoke), scripts/release-preflight.mjs
(npm release gate), scripts/sync-qdrant-to-pgvector.mjs (one-shot data
migration tool). Per script: port to Go, delete as obsolete (the qdrant
sync may already be spent), or record as accepted build-time Node
tooling. release-preflight's fate follows the npm-package decisions —
if npm publishing stays, its gate stays.

## Acceptance criteria

- [x] each of the three scripts has a recorded disposition (ported / deleted / kept with reason)
- [x] anything deleted is removed from package.json scripts and docs
- [x] anything kept is named in the milestone goal's accepted-exceptions list

## Evidence

- doc-smoke.mjs → KEPT as accepted build-time Node tooling: a zero-dependency CI doc-invariant gate (issue #73 lineage) running in the test job where Node is already required by the docs-site/admin-ui builds; a Go port buys nothing. Named in the milestone's accepted-exceptions list.
  - **REVERSED 2026-09-12 — ported to `go/cmd/doc-smoke`.** The disposition was right on its own terms and both terms expired. "A Go port buys nothing" assumed the invariants were self-contained regex checks over prose; they are not any more. The newer ones compare documentation against Go sources of truth — the config registry, `tooldefs.json`, the generated OpenAPI document — and a Node script can only reach those by carrying a second copy, which is the drift this repo keeps deleting. "Zero-dependency" expired the moment the first such check landed: `pnpm docs:smoke` was made to shell into `go run`, which broke the Node-only test job twice in one afternoon. Ported with parity verified across 11 injected violations, byte-identical findings in both.
- release-preflight.mjs → DELETED-BY 20260820-retire-npm-release-machinery: it is the npm publish gate and dies with npm publishing (ADR 0001+0002), sequenced after the final deprecation versions ship — deleting it here would break the still-pending deprecation publishes.
- sync-qdrant-to-pgvector.mjs → PORT to go/cmd, tracked as 20260820-port-qdrant-sync-to-go: the Go server's own pgvector remediation message prescribes running it, so it is runtime operator tooling, not build tooling. gen-runtime-package.mjs was already deleted in sprint 001.
- nothing deleted in this story, so no package.json/docs removals were due; the one pending deletion is owned by the retire-npm story with its ordering constraint recorded
