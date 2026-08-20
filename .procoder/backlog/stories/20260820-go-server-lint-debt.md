# Burn down go/ golangci-lint findings and gate it in CI

Status: open
Created: 2026-08-20
Epic: post-migration-gaps
Sprint: -

## Description

Running golangci-lint over go/ (now possible from the repo root via
go.work) reports 24 findings: errcheck 8, staticcheck 4, unused 12.
clients/go is lint-clean and CI-gated; the server module is not. Judge
each finding (unused may be dead migration-era code — deletion
candidates), fix what is real, then extend the CI golangci step to
cover go/ so the gate holds.

## Acceptance criteria

- [ ] every current finding fixed or suppressed inline with a reason
- [ ] CI runs golangci-lint over go/ (extend the existing clients/go step) and is green
- [ ] `go test ./...` still green in go/

## Evidence

