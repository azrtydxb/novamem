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

**Outcome (2026-09-10):** merged as fd853b9 (squash), branch deleted.
`docker (arm64)` had not failed on its merits — it was cancelled after
24h queued with no runner. Once runners returned, two advisories
published since 24 Aug blocked it instead: CVE-2026-56854 (CRITICAL,
golang.org/x/crypto 0.52.0 → 0.55.0, caught by Trivy) and six HIGH
fast-uri advisories (→ 4.1.4, caught by pnpm audit). Both fixed; all 12
checks green at merge.

## How far to take the deprecated-package cleanup?

Four TypeScript packages (~6,568 LOC) are superseded by Go and still in
the tree, still pulling npm dependencies we pay to patch — the fast-uri
advisory just fixed came from `packages/mcp`, which `go/cmd/novamem-mcp`
already replaced.

Two recorded decisions currently gate deleting them:

- **ADR 0002** — publish a final npm version carrying the deprecation
  README, THEN delete. Note `npm deprecate` marks already-published
  versions and needs no source, so deleting first does not prevent
  deprecating; it only skips the final README-bearing release.
- **ADR 0004** — reproduce a published benchmark number in the Go
  harness BEFORE deleting `packages/benchmarks`, so docs/benchmarks/
  claims stay reproducible. The model endpoint is reachable again, so
  this is now possible rather than blocked.

Options:

- Delete client + mcp + init now; keep benchmarks until the Go harness
  reproduces a published number (honours ADR 0004, ends most of the
  maintenance).
- Delete all four now, accepting that the published benchmark numbers
  lose their original harness.
- Publish the final deprecation versions first (owner action), then
  delete everything.
- Delete nothing yet.

**Decision (2026-09-10, owner):** delete client + mcp + init now; keep
`packages/benchmarks` until the Go harness reproduces a published
number (ADR 0004 still stands, and the models are reachable again).

## How far to take the MCP session-affinity fix?

Connecting Claude Code to the kw deployment exposed a scaling defect:
`go/internal/mcp/transport.go` keeps MCP sessions in an in-process map,
so with `replicas: 3` an `initialize` lands on one pod and follow-up
POSTs are round-robined to pods that never saw it — measured 4/9 then
8/20 reused-session calls succeeding, and Claude Code reporting
`HTTP 404: unknown sessionId`.

The cluster is fixed and Claude is connected: a dedicated `novamem-mcp`
Service for the `/mcp` paths plus its own ingress annotated
`upstream-hash-by: "$http_authorization"` pins each bearer to one pod
(20/20). The separate Service is load-bearing — sharing the main Service
collapses both ingresses onto one nginx upstream and the annotation is
silently ignored.

What is unresolved is how much of this becomes durable repo/infra state.
`deploy/k8s/novamem.yaml` ships `replicas: 1`, so the shipped default is
safe, but nothing warns an operator that scaling out silently breaks
every MCP client, and the Service + ingress exist only as live cluster
objects and scratchpad YAML — a rebuild of the out-of-tree overlay drops
them. Backlog story:
`.procoder/backlog/stories/20260910-mcp-sessions-block-horizontal-scaling.md`.

Options:

- **Document + persist.** PR the manifest warning at `replicas:`, the
  affinity recipe under `docs/`, and the backlog story; fold the Service
  and ingress into the kw overlay so they survive a rebuild. Leaves the
  session model as-is (single-pod by contract, affinity to scale out).
- **Persist the infra only.** Fold Service + ingress into the overlay,
  commit the story, skip the repo-facing docs for now.
- **Fix the session model properly.** Make sessions shared or let a pod
  adopt an unknown-but-well-formed session id bound to the authenticated
  caller, removing the need for affinity. Needs a security review first,
  since session ids would become caller-assertable.
- **Leave it.** Cluster works, story is filed; revisit when something
  actually needs to scale out.

**Decision (2026-09-10, owner):** fix the session model properly — remove
the need for ingress affinity rather than documenting it. Security review
first, since session ids would become caller-assertable.
