# Delete packages/server entirely

Status: done 2026-08-20
Created: 2026-08-20
Epic: spec-cleanup-phase
Sprint: -

## Description

The TS server was the conformance oracle during the migration; the spec
requires it deleted whole once the Go server is bench's default, leaving
git history as the archive.

## Acceptance criteria

- [x] packages/server does not exist in the tree
- [x] no workspace/package.json references @novamem/server or @azrtydxb/novamem-server
- [x] conformance suite is green against the Go server alone

## Evidence

- `ls packages/server` → No such file or directory (2026-08-20)
- `grep -rn "novamem-server" package.json packages/*/package.json` → only go/ binary name, no npm package
- go-parity-audit.md addendum + spec header: conformance 102 passed / 1 skipped / 0 failed vs Go; memory 2026-08-14: bench green, conformance is the only oracle
