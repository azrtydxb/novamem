# SDK T18: documentation

Status: open
Created: 2026-09-25

## Description

Write a README for each of the nine SDKs, a docs-site SDKs page and the root README SDK table, with quickstarts compiled in CI and operations tables checked against routes.json (plan Task 18, spec S-15).

## Acceptance criteria

- [ ] `sh scripts/check-sdk-readmes.sh` exits 0
- [ ] Deleting the `search` row from clients/python/README.md fails the script (mutation check, reverted)
- [ ] `cd packages/docs-site && pnpm build` passes with the SDKs page in the sidebar
- [ ] The root README.md has the SDK table, and the `readmes` job is in sdk.yml

## Evidence
