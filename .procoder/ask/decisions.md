## PR #248 has sat open and BLOCKED for two weeks — what now?

The procoder-audit + TS→Go migration branch (25 commits) is still open.
All checks passed except `docker (arm64)`, a required check that was
queued because the ARC runners were down. Copilot never reviewed it —
it declined at over 20,000 lines, so the automated review CLAUDE.md
relies on never engaged.

Options:

- Re-check `docker (arm64)` and merge (squash + delete branch) if the
  required checks are now green.
- Split the branch into per-theme PRs so Copilot can actually review it,
  then merge those.
- Leave the PR alone and start on the open issues (#139 telemetry
  dashboard, #140 backup/restore verification).
- Leave everything as is for now.

**Decision (2026-09-10, owner):** re-check `docker (arm64)` and merge if
the required checks are green. Copilot's missing review is accepted.
