# SDK T8: TypeScript SDK

Status: open
Created: 2026-09-25

## Description

Ship clients/typescript (npm `@azrtydxb/novamem` 2.0.0, no dependencies, AbortSignal support), held to the shared scenario suite (plan Task 8, spec S-5).

## Acceptance criteria

- [ ] `cd clients/typescript && npm test` passes on Node 20 and 24
- [ ] Removing the degraded-empty check fails `search-degraded-empty-is-unavailable` (mutation check, reverted)
- [ ] package.json has no `dependencies` key, and `npm pack --dry-run` ships only dist/ plus metadata
- [ ] `smoke.mjs` exists, and the `typescript` job is in sdk.yml

## Evidence
