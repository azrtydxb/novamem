# SDK T5: Go client runs the scenario suite

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Run the shared scenarios against clients/go, the reference implementation, so the suite is proven against a binding that already behaves correctly (plan Task 5, spec S-1).

## Acceptance criteria

- [x] `cd clients/go && go test -count=1 -run TestScenarios ./...` passes every sub-test
- [x] Removing the degraded-empty block in degradedEmpty fails `search-degraded-empty-is-unavailable` (mutation check, reverted)
- [x] Any Go client fix made here is named in the commit body

## Evidence

- `cd clients/go && go test -count=1 ./...` → `ok github.com/azrtydxb/novamem/clients/go 3.177s`; all 80 TestScenarios sub-tests pass.
- Mutation: disabling the degradedEmpty check → `--- FAIL: TestScenarios/search-degraded-empty-is-unavailable … outcome = empty (err: <nil>), want unavailable`. Removing the redaction → `--- FAIL: TestScenarios/token-echoed-in-401-is-redacted … token leaked into the error`. Both reverted, and `git diff novamem.go` is empty.
- No Go client fix was needed. The only runner-side changes were messageContains becoming case-insensitive (`Token is required`) and building the server binary instead of `go run` (orphan held the output for 60s).
