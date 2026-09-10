# Workflow rules

Repo-level rules the procoder skills read and follow. Edit freely — what is
written here wins over the skills' built-in defaults.

## Worktrees

Feature work happens in a git worktree (one per branch/agent) so the default
branch checkout stays clean and parallel agents never collide. Use the
harness's native worktree support when available, `git worktree add` otherwise.

## Reviews before merge

Never merge a PR before every Copilot and Claude review comment is resolved
(see CLAUDE.md). Arm auto-merge only after review comments are addressed.

## After a successful merge

Clean up: delete the remote branch (merge with `--delete-branch`), delete the
local branch, remove the worktree if one was used, run `git fetch --prune`,
and return to an updated default branch.
