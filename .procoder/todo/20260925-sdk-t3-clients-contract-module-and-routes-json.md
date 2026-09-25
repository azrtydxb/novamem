# SDK T3: clients/contract module and routes.json

Status: open
Created: 2026-09-25

## Description

Create the language-neutral route map every SDK is checked against, move the Go routeMap into it, and fix the four entries that name the wrong class (plan Task 3, spec S-2).

## Acceptance criteria

- [ ] `cd clients/contract && go test -count=1 ./...` passes TestRoutesJSONCoversOpenAPI, TestWrappedRoutesDeclareResponseSchema and TestSurfaceIsFortyOneMethods
- [ ] `cd clients/go && go test -count=1 -run TestEveryRouteIsAccounted ./...` passes
- [ ] Renaming `Management.Decay` to `Client.Decay` in routes.json makes TestEveryRouteIsAccounted fail (mutation check, reverted)
- [ ] `go.work` lists `./clients/contract`, and ci.yml runs its tests

## Evidence
