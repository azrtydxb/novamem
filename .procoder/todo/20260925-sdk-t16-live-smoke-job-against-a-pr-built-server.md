# SDK T16: live smoke job against a PR-built server

Status: open
Created: 2026-09-25

## Description

Add the sdk-smoke CI job: Postgres plus a server built from the PR, a live schema check of the new response schemas, and every SDK's capture, search, forget and outage round trip (plan Task 16, spec S-13 and S-16).

## Acceptance criteria

- [ ] `cd clients/smoke && go test -count=1 ./...` passes TestValidateCatchesMissingRequired, with TestResponsesMatchSchemas skipping loudly offline
- [ ] `sdk-smoke` is green on the PR, with `PASS <lang> up` and `PASS <lang> down` for all nine languages
- [ ] A scratch commit making python smoke `down` accept empty results fails the job with `FAIL python` (dropped before merge)
- [ ] A scratch required field `bogus` on ProvisionedUser fails TestResponsesMatchSchemas (dropped before merge)

## Evidence
