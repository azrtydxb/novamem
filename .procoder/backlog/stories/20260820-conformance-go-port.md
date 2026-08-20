# Port the conformance suite to Go (executes ADR 0003)

Status: open
Created: 2026-08-20
Epic: conformance-oracle-language
Sprint: 003-the-conformance-oracle-speaks-go

## Description

Port packages/conformance to a standalone Go module that drives a
novamem URL black-box, per ADR 0003: no import of go/internal, no shared
helpers, HTTP only. Case-count parity is pinned before the TS suite is
deleted, and every case's assertions are validated against the TS
original — a port that silently asserts less than the TS case it
replaces is a regression in the oracle, not progress.

## Acceptance criteria

- [ ] Go suite runs the same 103 cases (declared and mode-skip behaviour matching the TS suite)
- [ ] a module-boundary check fails the build if the suite imports go/internal
- [ ] per-case assertion review recorded (spot-checkable mapping TS case → Go case)
- [ ] one full run green against the bench deployment; CI wired to the Go suite
- [ ] packages/conformance deleted afterwards in its own commit

## Evidence

