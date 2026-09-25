# SDK T6: type generator core

Status: open
Created: 2026-09-25

## Description

Build clients/gen: OpenAPI JSON plus routes.json into an IR, template execution, and a -check mode that fails on stale generated files (plan Task 6, spec S-3).

## Acceptance criteria

- [ ] `cd clients/gen && go test -count=1 ./...` passes TestBuildModel, TestCheckReportsStale and TestUnsupportedConstructFails
- [ ] `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -check` exits 0
- [ ] The `generated` job exists in sdk.yml

## Evidence
