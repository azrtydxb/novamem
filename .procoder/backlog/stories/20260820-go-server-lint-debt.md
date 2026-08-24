# Burn down go/ golangci-lint findings and gate it in CI

Status: done 2026-08-20
Created: 2026-08-20
Epic: post-migration-gaps
Sprint: 002-server-module-gated-and-soak-proven-the-mcp-stdio-shim

## Description

Running golangci-lint over go/ (now possible from the repo root via
go.work) reports 24 findings: errcheck 8, staticcheck 4, unused 12.
clients/go is lint-clean and CI-gated; the server module is not. Judge
each finding (unused may be dead migration-era code — deletion
candidates), fix what is real, then extend the CI golangci step to
cover go/ so the gate holds.

## Acceptance criteria

- [x] every current finding fixed or suppressed inline with a reason
- [x] CI runs golangci-lint over go/ (extend the existing clients/go step) and is green
- [x] `go test ./...` still green in go/

## Evidence

- unused (12): go/internal/httpapi/metrics.go was a dead pre-refactor duplicate of the internal/metrics package — deleted whole (`git rm`), nothing referenced it
- errcheck (8): `_ =` on test Body.Close/recover sites and the qdrant.go response close
- staticcheck (4): config/pgvector error-string punctuation fixed; validate.go errMalformedJSON suppressed inline with reason (byte-for-byte Fastify wording is the error-shape contract); ulid_test De Morgan applied
- `golangci-lint run ./go/...` → "0 issues."; CI go job now lints both modules (actionlint clean); `go build ./... && go test ./...` green in go/

