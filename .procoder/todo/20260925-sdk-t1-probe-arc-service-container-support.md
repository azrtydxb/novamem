# SDK T1: probe ARC service-container support

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Find out whether the arc-azrtydxb-amd64 runners can run GitHub Actions service containers. Task 16's live smoke job either starts Postgres that way or falls back to installing it on the runner. Done when the answer is recorded in plan Task 1, which Task 16 reads (the draft probe PR is never merged).

## Acceptance criteria

- [x] `actionlint .github/workflows/sdk.yml` exits 0
- [x] The `probe` job ran on a draft PR, and its outcome (`services ok` or the container-init failure) is quoted in the evidence
- [x] The outcome is recorded in plan Task 1 (`SERVICES_OK = true`), and Task 16 is updated to use `services.postgres`

## Evidence

- actionlint: `actionlint .github/workflows/sdk.yml` printed nothing and exited 0 (branch feat/sdk-probe, commit on PR #306).
- Probe: run 36098964791 on arc-azrtydxb-amd64 concluded `success`. The log shows `docker pull pgvector/pgvector:pg16`, the container `healthy`, and the step output `services ok` (05:32:38Z).
- Recorded: plan Task 1 status block and Task 16 services block, on PR #305.
