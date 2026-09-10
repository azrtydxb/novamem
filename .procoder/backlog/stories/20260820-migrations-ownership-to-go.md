# Move schema migration ownership into the Go tree

Status: done 2026-08-20
Created: 2026-08-20
Epic: spec-cleanup-phase
Sprint: -

## Description

During the migration Drizzle owned the schema and Go refused to start
against an unknown journal version. Post-parity, the Go tree owns
migrations and drizzle-kit tooling is gone.

## Acceptance criteria

- [x] SQL migrations live in the Go tree and are applied by the Go server
- [x] no drizzle-kit dependency or config remains in the workspace
- [x] migration application is covered by Go tests

## Evidence

- go/internal/warmstore/migrations/\*.sql (8 files) + migrations.go apply logic (2026-08-20)
- `grep -rn "drizzle-kit" package.json packages/*/package.json` → no matches; remaining "drizzle" hits are prose in prompts/tests
- go/internal/warmstore/migrations_apply_test.go and migrations_journal_test.go exist and pass in `go test ./...`
