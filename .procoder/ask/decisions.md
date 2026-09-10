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

## Do we move to MCP 2026-07-28, and how do we fix the 2025-03-26 batching gap?

Audited 2026-09-10 against the published spec. The current revision is
**2026-07-28**; we advertise `2024-11-05 … 2025-11-25`, i.e. the spec's
**Legacy era** (servers with an `initialize` handshake). 2026-07-28
removed that model wholesale: no `initialize`, no protocol-level
sessions or `Mcp-Session-Id`, no GET stream, no `Last-Event-ID`
resumability, no `ping`; `server/discover` becomes a MUST; every request
carries version/clientInfo/capabilities in `_meta`; results carry
`resultType`; `tools/list` carries `ttlMs` + `cacheScope`; new required
`Mcp-Method`/`Mcp-Name` headers with header↔body validation; new error
codes `-32020` HeaderMismatch and `-32022` UnsupportedProtocolVersion.

Measured, current state:

- Dual-era clients work against us — the spec's compatibility matrix
  says so, and Claude Code connects and calls tools today. Our `400` +
  `-32000` for an unknown version is _not_ a recognized modern error,
  which is exactly the signal that makes a dual-era client fall back to
  `initialize`. `-32000` is grandfathered as implementation-defined
  under the new error-code policy.
- A **modern-only** client fails against us. None is in play today.
- **Confirmed MUST violation:** 2025-03-26 requires receiving JSON-RPC
  batches; we answer an array body with `-32700 Parse error`. Scope is
  that one advertised version (batching was removed in 2025-06-18;
  2024-11-05 never required it). Inherited from `mcp-spec-guards.ts`.
- Our `/mcp/sse` + `/mcp/messages` pair is the 2024-11-05 HTTP+SSE
  transport, now formally Deprecated (earliest removal three months
  after SEP-2596 is Final).
- Minor: no `X-Accel-Buffering: no` on SSE responses (a new SHOULD).
  Streaming is verified working through the plain ingress regardless.
- Already conformant, including under the new revision: 403 on invalid
  Origin, deterministic `tools/list` order, tool failures as `isError`
  content rather than protocol errors.

ADR 0005's signed session ids are aligned with the direction of travel —
2026-07-28 removes sessions entirely, making them unnecessary rather
than wrong.

Options for the revision:

- **Dual-era.** Add a modern surface (`server/discover`, `_meta`
  negotiation, `resultType`, cache fields, header validation, new error
  codes) alongside the existing legacy handshake, and keep serving both
  from the same endpoint as the spec permits. Largest effort; nothing
  currently working breaks.
- **Stay legacy, fix the gaps.** Keep the handshake, fix batching and
  the SSE buffering header. Correct against everything we advertise, but
  a modern-only client cannot use novamem.
- **Modern-only.** Implement 2026-07-28 and drop the legacy handshake.
  Smallest end state, breaks every client that has not moved — Claude
  Code included, until it does.
- **Nothing yet.** Revisit when a client we care about goes modern-only.

Options for the batching MUST (independent, small):

- Implement batch receive so `2025-03-26` is honestly supported.
- Drop `2025-03-26` from `SupportedProtocolVersions` and advertise only
  what we implement.

**Decision (2026-09-10, owner):** go **dual-era** — add the modern
2026-07-28 surface alongside the legacy handshake on the same endpoint —
and **drop 2025-03-26** from the advertised list rather than implementing
batch receipt for a dead-end code path. Implemented in ADR 0006.

## What to do about the per-replica rate limiter?

Found 2026-09-10 while running the conformance suite against the kw
deployment. `go/internal/httpapi/ratelimit.go` keeps counters in an
in-process `map[string]rateEntry`, so each replica enforces the
configured budget independently. Measured on 3 replicas, one request per
connection: `remaining = 593, 592, 593, 593, 592, 591` — three counters.
Effective allowance is roughly 3× the configured one.

Rate limiting is a protection, so this weakens a security control rather
than only making a header inconsistent. It is the same class as the MCP
session map (ADR 0005) and the pod-local SSE transport.

`TestRateLimiting` does **not** reliably catch it: in a full conformance
run Go's `http.Client` reuses one keepalive connection, which nginx pins
to a single upstream, so it passes; run in isolation it fails 6/6. A
test that only passes because of connection reuse is not testing the
property it claims, so any fix has to address the test too.

Options:

- **Shared counter** (Postgres, or Redis if we want to add it). Correct
  under any replica count; costs a round trip per limited request.
- **Divide the budget by the replica count.** No new dependency and no
  per-request cost, but approximate, and wrong under uneven balancing or
  during a rollout when replica count changes.
- **Document it as a single-replica-only guarantee** and note it in
  `deploy/k8s/novamem.yaml` next to the existing caveats. Honest and
  free; leaves the protection weakened for anyone who scales out.
- **Accept as-is.** The budget is generous and this is a dev deployment.

Independent of the choice, `TestRateLimiting` should be made
connection-reuse-independent so the property is actually covered.
