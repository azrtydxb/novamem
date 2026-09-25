# SDK T2: response schemas for the nine wrapped routes

Status: open
Created: 2026-09-25

## Description

Landed ahead of the plan on branch fix/sdk-prereqs; close by verifying it. Declare response schemas in api/openapi.yaml for the nine SDK-wrapped routes that have none, transcribed from their Go handlers, so the generator can type every SDK result (plan Task 2, spec S-16).

## Acceptance criteria

- [ ] The plan's Task 2 Python check exits 0 against `docs/api/openapi.json`
- [ ] `cd go && go run ./cmd/gen-contract && git diff --exit-code ../docs/api/openapi.json` is clean after the commit
- [ ] `cd go && go test ./internal/httpapi/...` passes
- [ ] Each schema's field list was checked against its handler's `writeJSONValue` call (the evidence names each handler)

## Evidence
