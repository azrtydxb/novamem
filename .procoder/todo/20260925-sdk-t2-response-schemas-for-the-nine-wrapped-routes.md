# SDK T2: response schemas for the nine wrapped routes

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Landed ahead of the plan on branch fix/sdk-prereqs; close by verifying it. Declare response schemas in api/openapi.yaml for the nine SDK-wrapped routes that have none, transcribed from their Go handlers, so the generator can type every SDK result (plan Task 2, spec S-16).

## Acceptance criteria

- [x] The plan's Task 2 Python check exits 0 against `docs/api/openapi.json`
- [x] `cd go && go run ./cmd/gen-contract && git diff --exit-code ../docs/api/openapi.json` is clean after the commit
- [x] `cd go && go test ./internal/httpapi/...` passes
- [x] Each schema's field list was checked against its handler's `writeJSONValue` call (the evidence names each handler)

## Evidence

- Plan Task 2 check: the script printed `schema check: PASS` against docs/api/openapi.json, exit 0 (branch fix/sdk-prereqs, commit b5a6785).
- gen-contract: `cd go && go run ./cmd/gen-contract` rewrote the outputs, and `git status` showed no further diff after commit b5a6785.
- httpapi: `cd go && go test ./internal/httpapi/...` printed `ok github.com/azrtydxb/novamem/go/internal/httpapi`.
- Handlers checked: admin.go handleAdminRevoke, handleAdminUsers (warmstore.UserRow), handleAdminUserCreate (201), handleAdminUserDelete (engine.DeleteUserResult / dryRun map), handleAdminQuota (GetUserQuota \*int); me.go handleMeExport (warmstore.Entry), handleMeImport (201/400), handleMeTokenDelete; search.go handleContextPrefix. Live validation is pending: TestResponsesMatchSchemas, Task 16.
