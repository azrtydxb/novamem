# SDK T4: scenario server and scenarios.json

Status: open
Created: 2026-09-25

## Description

Build the Go scenario server and the shared scenario file that define the behaviour every SDK must reproduce (plan Task 4, spec S-1).

## Acceptance criteria

- [ ] `cd clients/contract && go test -count=1 ./...` passes TestScenarioServerReplaysAndRecords, TestEveryMethodHasAScenario and TestErrorTableIsCovered
- [ ] `go run ./cmd/scenario-server -scenarios scenarios.json` prints `listening http://127.0.0.1:<port> closed=<port>`
- [ ] scenarios.json covers all 41 methods, plus the 14 error rows for both search and capture

## Evidence
