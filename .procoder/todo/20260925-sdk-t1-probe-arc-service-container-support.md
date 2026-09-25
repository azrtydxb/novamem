# SDK T1: probe ARC service-container support

Status: open
Created: 2026-09-25

## Description

Find out whether the arc-azrtydxb-amd64 runners can run GitHub Actions service containers. Task 16's live smoke job either starts Postgres that way or falls back to installing it on the runner. Done when the answer is recorded on line 1 of .github/workflows/sdk.yml (plan Task 1).

## Acceptance criteria

- [ ] `actionlint .github/workflows/sdk.yml` exits 0
- [ ] The `probe` job ran on a draft PR, and its outcome (`services ok` or the container-init failure) is quoted in the evidence
- [ ] Line 1 of `.github/workflows/sdk.yml` reads `# probe: services ok` or `# probe: services unavailable`

## Evidence
