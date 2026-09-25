# SDK T3: clients/contract module and routes.json

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Create the language-neutral route map every SDK is checked against, move the Go routeMap into it, and fix the five entries that name the wrong class (plan Task 3, spec S-2).

## Acceptance criteria

- [x] `cd clients/contract && go test -count=1 ./...` passes TestRoutesJSONCoversOpenAPI, TestWrappedRoutesDeclareResponseSchema and TestSurfaceIsFortyOneMethods
- [x] `cd clients/go && go test -count=1 -run TestEveryRouteIsAccounted ./...` passes
- [x] Renaming `Management.Decay` to `Client.Decay` in routes.json makes TestEveryRouteIsAccounted fail (mutation check, reverted)
- [x] `go.work` lists `./clients/contract`, and ci.yml runs its tests

## Evidence

- contract: `cd clients/contract && go test -count=1 -v ./...` passed TestRoutesJSONCoversOpenAPI, TestWrappedRoutesDeclareResponseSchema, TestSurfaceIsFortyOneMethods and TestLoadRoutesRejectsAmbiguousEntries.
- Go client: `cd clients/go && go test -count=1 -run TestEveryRouteIsAccounted -v ./...` printed `--- PASS: TestEveryRouteIsAccounted`.
- Mutation: `Management.Decay` → `Client.Decay` in routes.json printed `routecoverage_test.go:52: POST /v1/decay: Client has no method Decay`; reverted, and the suite is green again.
- Wiring: go.work lists ./clients/contract; the ci.yml go job runs its build/vet/test (-count=1) plus golangci-lint (local run: `0 issues.`); `actionlint .github/workflows/ci.yml` is clean.
- routes.json: 55 routes, the same keys as the old Go routeMap, 41 methods; every op string was checked against the `c.do(ctx, "<op>", …)` calls in clients/go.
