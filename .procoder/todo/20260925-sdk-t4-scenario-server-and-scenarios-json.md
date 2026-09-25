# SDK T4: scenario server and scenarios.json

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Build the Go scenario server and the shared scenario file that define the behaviour every SDK must reproduce (plan Task 4, spec S-1).

## Acceptance criteria

- [x] `cd clients/contract && go test -count=1 ./...` passes TestScenarioServerReplaysAndRecords, TestEveryMethodHasAScenario and TestErrorTableIsCovered
- [x] `go run ./cmd/scenario-server -scenarios scenarios.json` prints `listening http://127.0.0.1:<port> closed=<port>`
- [x] scenarios.json covers all 41 methods, plus the 14 error rows for both search and capture

## Evidence

- contract: `cd clients/contract && go test -count=1 ./...` → `ok` (TestScenarioServerReplaysAndRecords, TestSubset, TestEveryMethodHasAScenario, TestErrorTableIsCovered, plus the Task 3 tests).
- CLI: `sh clients/contract/scenario-server.sh -scenarios scenarios.json` printed `listening http://127.0.0.1:59893 closed=59892`; `GET /s/health-ok-false/health` replayed `{"ok": false}`, and `/_verdict/health-ok-false` returned `{"requests":1,"mismatches":[]}`. After the kill, no orphan process remained.
- Coverage: 80 scenarios, including all 41 methods and the 14 error rows for both search and capture (enforced by TestEveryMethodHasAScenario and TestErrorTableIsCovered). golangci-lint: `0 issues.`
