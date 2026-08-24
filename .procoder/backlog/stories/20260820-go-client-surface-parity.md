# Prove clients/go covers the TS client surface

Status: done 2026-08-20
Created: 2026-08-20
Epic: client-library-go-parity
Sprint: 001-close-the-decision-free-debt-dead-ts-server-scaffolding

## Description

clients/go exists with 42 exported methods (Client 15, Management 21,
Admin 6) vs the TS client's 34 async methods, and ships a surface test.
Turn "plausibly complete" into "proven": enumerate the TS client's
public surface, map each method to its Go counterpart, close any gap.
Note: clients/go is currently NOT lint-covered (golangci-lint fails
there — "no go files to analyze"; likely its own module missing from the
lint config) — fix that here so the client is gated like the rest.

## Acceptance criteria

- [x] written method-for-method map TS→Go with no unmapped TS method
- [x] surface_test.go pins the mapped surface (fails when a route is added to openapi.json without a client method)
- [x] golangci-lint actually analyzes clients/go in CI

## Evidence

- clients/go/routecoverage_test.go: routeMap covers all 56 openapi.json routes — every public TS client method (33; `request` is private) maps to a Go method, each unwrapped route carries a written non-goal reason; TestEveryOpenAPIRouteIsMappedOrDeclaredNonGoal PASSes and fails on any unmapped route addition/removal
- gap found and closed: Management.RemoveProjectMemberByUsername ported (the one TS method without a Go counterpart)
- root go.work added (modules go/ and clients/go) — root-invoked golangci-lint now analyzes clients/go ("0 issues"); previously "no go files to analyze"
- CI go job runs golangci-lint v2.12.2 in clients/go (verified locally: exit 0); actionlint clean; go build+test green in both modules
- follow-up recorded: 20260820-go-server-lint-debt (24 pre-existing findings in go/, out of this story's scope)

