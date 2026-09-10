# 0003 — Port the conformance suite to Go

Status: accepted
Date: 2026-08-20

## Context

packages/conformance is the black-box oracle: ~103 cases driving the
full HTTP/MCP surface by URL. Its independence from the server's stack
is what caught the parity defects (framework-default divergences
invisible to code review). It is also the last TS test runtime once the
other migration epics land.

## Decision

Port to Go, with guardrails that preserve the black-box property by
discipline instead of by stack: the suite lives in its own Go module,
imports nothing from go/internal (enforced by a module-boundary check),
and speaks to the server only over HTTP — no shared types, no shared
helpers. Case-count parity (103) is pinned before the TS suite is
deleted. Rejected: staying TS — defensible for independence, but it
keeps a Node test runtime alive forever in a repo whose stated goal is
Go everywhere outside the browser.

## Consequences

Easier: one language for all server-side code and its gate; conformance
runs from a compiled binary in CI with no pnpm install. Harder: the
independence guarantee is now a reviewed rule rather than a structural
fact — the module-boundary check must actually exist and block; the
port itself must be validated case-by-case against the TS suite's
assertions (a silently weakened port is worse than none).
