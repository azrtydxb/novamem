# SDK T5: Go client runs the scenario suite

Status: open
Created: 2026-09-25

## Description

Run the shared scenarios against clients/go, the reference implementation, so the suite is proven against a binding that already behaves correctly (plan Task 5, spec S-1).

## Acceptance criteria

- [ ] `cd clients/go && go test -count=1 -run TestScenarios ./...` passes every sub-test
- [ ] Removing the degraded-empty block in degradedEmpty fails `search-degraded-empty-is-unavailable` (mutation check, reverted)
- [ ] Any Go client fix made here is named in the commit body

## Evidence
