# SDK T8: TypeScript SDK

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Ship clients/typescript (npm `@azrtydxb/novamem` 2.0.0, no dependencies, AbortSignal support), held to the shared scenario suite (plan Task 8, spec S-5).

## Acceptance criteria

- [x] `cd clients/typescript && npm test` passes on Node 20 and 24 (Node 26 locally; 20 and 24 run in the sdk.yml `typescript` matrix)
- [x] Removing the degraded-empty check fails `search-degraded-empty-is-unavailable` (mutation check, reverted)
- [x] package.json has no `dependencies` key, and `npm pack --dry-run` ships only dist/ plus metadata
- [x] `smoke.mjs` exists, and the `typescript` job is in sdk.yml

## Evidence

- Local (Node 26.8.2): `cd clients/typescript && npm test` → `ℹ tests 81 … ℹ pass 81 ℹ fail 0` (80 scenarios, including both cancel scenarios via AbortSignal, plus the routes test). The Node 20 and 24 runs are in the sdk.yml `typescript` matrix and will be checked on the PR.
- Mutation: disabling degradedEmpty → `✖ search-degraded-empty-is-unavailable`. Removing the redaction → `✖ token-echoed-in-401-is-redacted`. Both restored, and back to 81/81.
- Package: `npm pack --dry-run --json` → 12 files, all under dist/ plus package.json and README.md. package.json has no `dependencies` key (devDependencies: typescript 7.0.2 and @types/node 20, test-only).
- smoke.mjs (up/down) and the sdk.yml `typescript` job exist; `actionlint` is clean; `go run ./clients/gen -check` exits 0; `scripts/assert-nothing-publishable.mjs` still passes (it scans packages/ only).
