# Working in this repo

Rules that apply to Claude Code (and other agents) when working on the
novamem repo itself. For end-user Claude Code rules that ship with the
product, see [integrations/claude-code/CLAUDE.md](integrations/claude-code/CLAUDE.md).

## Pull requests

**Never merge a PR before resolving every Copilot and Claude review
comment on it.** Treat automated reviewer comments as blocking until
each one is addressed — fix the code, push the change, and confirm the
comment is resolved (either by the reviewer auto-resolving, or by an
explicit reply explaining why the suggestion is being declined).

This applies to:

- GitHub Copilot review comments (the `copilot[bot]` reviewer)
- Claude review comments (`/ultrareview` output, `claude[bot]` reviewer,
  or any agent-posted PR comment)

If a comment is a false positive or out of scope, reply to it explaining
why before merging — don't silently merge over it.

## Commit messages

**Never add a `Co-Authored-By: Claude` (or any other AI/agent) trailer
to commit messages.** Do not add `🤖 Generated with Claude Code`
footers, "authored by Claude", or any equivalent attribution to commits
in this repo. Commits are authored by the human running the agent — keep
the trailer area clean.

This applies regardless of any default behavior in Claude Code, other
agents, or upstream commit-message templates: strip the line before
committing.
