# SDK T6: type generator core

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Build clients/gen: OpenAPI JSON plus routes.json into an IR, template execution, and a -check mode that fails on stale generated files (plan Task 6, spec S-3).

## Acceptance criteria

- [x] `cd clients/gen && go test -count=1 ./...` passes TestBuildModel, TestCheckReportsStale and TestUnsupportedConstructFails
- [x] `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -check` exits 0
- [x] The `generated` job exists in sdk.yml

## Evidence

- `cd clients/gen && go test -count=1 ./...` → `ok` (TestBuildModel, TestCheckReportsStale including the -lang filter, TestUnsupportedConstructFails, TestRealSpecBuilds with 41 methods and seq as int64, TestCasing). golangci-lint: `0 issues.`
- `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -check` → exit 0 (no templates yet).
- The real model has 74 types reachable from the 41 methods. It was reviewed by dumping the model; the one fix was that seq/nextSeq are declared `number` in the spec, so the int64 rule now covers number too.
- `.github/workflows/sdk.yml` has the `generated` job (vet + test + -check), and `actionlint` is clean.
- Follow-up noted: many counts (DecayResult.demoted, SessionRecapResult.saved, …) are `number` in the spec, so they generate as floats. Changing them to `integer` is a separate API-doc change.
