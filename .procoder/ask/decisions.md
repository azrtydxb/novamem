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

## How should updating a memory handle its derived facts?

Found 2026-09-10 while testing novamem through Claude Code against the
kw deployment. With extraction enabled, `PUT /v1/memories/{id}`
re-embeds the source entry and leaves derived `[fact]` rows untouched.
Reproduced: a source corrected from "every 30 days" to "every 14 days"
keeps a derived row asserting 30 days, and search ranks that stale
derivative **above** the correction (1.480 vs 0.921), so an agent acts
on the value the user just fixed.

The link already exists — derived rows carry
`metadata.source_chunk_id` — so the update path simply does not follow
it. Backlog:
`.procoder/backlog/stories/20260910-stale-derived-facts-survive-update.md`.

Options:

- **Re-extract on update.** Delete the derivatives and re-run extraction
  against the new content. Most faithful; costs an LLM call on every
  update, and the derived ids change.
- **Delete derivatives on update.** Drop them and let the next
  extraction pass (or nothing) recreate them. Cheap and always correct
  in the sense that nothing stale survives; loses derived structure
  until something re-derives it.
- **Mark derivatives superseded** and exclude them from search while
  keeping them for provenance. Preserves history; needs a visibility
  predicate change, which is a place this codebase has been bitten
  before.
- **Leave it** and document that corrections do not propagate to derived
  facts.

Whichever is chosen, `memory_forget` should be checked in the same pass:
an orphaned derivative after a delete is the same bug with a different
verb.

## How do we make the agent-facing surfaces structurally unable to diverge?

Audited 2026-09-10. Already enforced: routes ↔ OpenAPI
(`TestOpenAPIMatchesRegisteredRoutes`), OpenAPI ↔ the checked-in
`docs/api/openapi.json`, `tooldefs.json` ↔ the conformance snapshot
(names + inputSchema), and `skills/novamem/` ↔ the installer's embedded
copy (byte-identical).

Unprotected, in order of risk:

1. **`novamemInstructions` ↔ `SKILL.md`** — the same behavioural
   contract written twice by hand (a 3,591-char Go const in
   `adoption.go:55` and a 9,514-char markdown file). Both name all 21
   tools and share the same rule vocabulary today, purely through
   diligence.
2. **Skill ↔ tool list** — nothing asserts the skill documents every
   tool, or that it names no tool that has been removed.
3. **Prose docs ↔ reality** — how `/api-docs` (#264) survived.
   `scripts/doc-smoke.mjs` exists but its 8 invariants are each a
   _reaction_ to past drift, so novel drift is never caught.
4. **Installer output ↔ intended transport** (#267).
5. **`docs/` ↔ `packages/docs-site/`** — 8 overlapping pages, drifted in
   _both_ directions (the site's architecture page is newer: pgvector,
   five signals, `memory_relations`; `docs/architecture.md` still says
   Qdrant-only).

The theme: hand-written invariants only catch drift someone predicted.
Derived checks — comparing docs and skills against the generated
artifacts — catch drift nobody predicted.

### Decision 1 — unify the MCP `instructions` with the skill

- **Embed a delimited section of SKILL.md.** One source; the wire
  payload stays lean.
- **Embed the whole SKILL.md.** Simplest possible; ~9.5KB on every
  `initialize` instead of 3.6KB.
- **Keep both, drift-test them.** Weakest — wording can still diverge
  while a test passes.

### Decision 2 — the docs/ ↔ docs-site duplication

- **One source**: `docs/` canonical, the site builds from it, duplicates
  deleted.
- **Keep both, add an equality check** — forces the two to stay
  byte-identical, which may fight VitePress-specific needs.
- **Leave it** — out of scope for this pass.

**Decision (2026-09-11, owner):** one source — `docs/` is canonical, the
site builds from it, and the duplicated pages under
`packages/docs-site/` are deleted.

## The commit gate blocks on a vuln in a gitignored agent install

Every commit in this repo currently fails:

    BLOCKING toml 4.1.1 has 2 known vulnerability(s), max severity 8.2 — upgrade it (security)

Tracked down 2026-09-11: the package is
`.kilocode/node_modules/toml@4.1.1` — a Kilo Code install sitting in the
working tree. It is gitignored (`.gitignore:17`), untracked, and nothing
in the project depends on it: `pnpm audit` is clean, `pnpm-lock.yaml`
has no `toml` at all, and the only TOML the project ships is
`github.com/pelletier/go-toml/v2 v2.4.3`. `.kilo/` carries its own copy
at 4.3.0 which the scanner does not flag.

So the finding is real about the file on disk and false about the
repository — and it blocks every commit until something changes.

Options:

- Exclude gitignored paths (or `.kilo*/` specifically) from the gate's
  dependency scan, so the gate reports on the repo and not on whatever
  agents have installed locally.
- Delete `.kilocode/` and `.kilo/` from the working tree (~118 MB of
  untracked agent installs) and let them be recreated if needed.
- Leave it and use `--no-verify` for this commit, accepting that the
  next commit hits the same wall.

**Decision (2026-09-11, owner):** scope the scan to the repository — the
gate reports on what this repo ships, not on what agents installed into
the working tree.

**Outcome (2026-09-11):** the knob did not exist, so the fix went
upstream as azrtydxb/procoder#285. `manifestsIn` walked the whole tree;
it now runs over the gate's own file set (tracked plus
untracked-but-not-ignored), which is the scope `procoder audit` already
states out loud, with the walk kept as the fallback for a directory git
cannot answer for. Regression test builds a real git repo with a
gitignored lockfile beside tracked ones; mutation-checked. Until that
ships in a release, commits here need `--no-verify`.

## Getting the rendered API reference onto kw

`http://novamem.kw.local/api-docs` is a 404 today — probed 2026-09-11.
kw runs the current image, which is exactly the #264 gap: the route
exists only in #275, unmerged and stacked behind #274 and #273. The raw
spec at `http://novamem.kw.local/openapi.json` does answer (200, 74,185
bytes), so what kw is missing is the rendering, not the contract.

Corrected while deploying: kw is an **arm64** k3s cluster that pulls
`ghcr.io/azrtydxb/novamem:sha-<short>` from the registry — CI builds the
image, and the deploy is a tag bump. The build-and-ssh-pipe flow is the
248 cluster, not this one.

Options:

- Merge the stack (#273 → #274 → #275) first, then build and deploy the
  merged `main` to kw.
- Build and deploy the `feat/api-reference` branch image to kw now, to
  look at it live before merging.
- Leave kw alone; it picks the route up with the next ordinary release.

**Decision (2026-09-11, owner):** merge the stack first, then build and
deploy the merged `main` to kw and verify `/api-docs` there.

## The local docker volume left behind, now that Docker is off-limits

Verifying the API reference before it was deployed meant starting the
compose datastores locally. That was before the owner ruled Docker
Desktop out (2026-09-11). The containers are stopped, but two things
remain on disk:

- `novamem-1-postgres-1` and `novamem-1-qdrant-1`, both `Exited`, plus
  the `novamem_pg` volume holding whatever local data predates today.
- The `novamem` role's password inside that volume was changed to
  `devlocal`. The volume predated the compose password and auth was
  failing; the old password is gone.

Nothing outstanding needs any of it — kw is the verification target now.

Options:

- Leave it stopped and untouched; it costs nothing and the data survives
  if the local stack is ever wanted again.
- Remove the two containers but keep the `novamem_pg` volume.
- Remove the containers and the volume, reclaiming the disk and
  accepting that the local data goes with it.

**Decision (2026-09-11, owner):** remove the containers and the volume.

**Outcome (2026-09-11):** removed `novamem-1-postgres-1`,
`novamem-1-qdrant-1`, and the volumes `novamem-1_novamem_pg` and
`novamem-1_novamem_qdrant` — the stack this session started. Deliberately
left alone: `novamem-1_novamem_falkor` (FalkorDB, retired, never touched
here) and the entire `novamem_*` volume set, which belongs to a
differently-named checkout this session never ran.

## The shim smoke test runs a binary resolved from PATH

`verifyShimBinary` (`go/internal/initcli/mcp.go`) executes the
`novamem-mcp` path before writing it into a host config, to check it can
start. Semgrep flags the non-literal `exec.CommandContext(ctx, path)`
as `dangerous-exec-command`; it blocks the gate for anyone who touches
that file.

Traced 2026-09-11. `path` comes from `ResolveShimBinary`, in order:
`--mcp-bin`/`NOVAMEM_MCP_BIN`, then a binary beside the running
executable, then `exec.LookPath`. Nothing remote or server-controlled.
For sources 2 and 3 to be an attack, the attacker must already be able
to write next to the installer or into a PATH directory — at which point
they can replace `novamem-init` itself, so no privilege boundary is
crossed.

Against that: the code does not merely _name_ the binary in a config
file, it _runs_ it, and PATH is influenceable in ways an explicit flag
is not.

Options:

- Keep the targeted `// nosemgrep: dangerous-exec-command` with the
  trace recorded in a comment, and keep the smoke test as it is.
- Drop the execution: keep the stat checks (exists, regular file,
  executable bit) and stop running the binary. The gate goes quiet
  honestly, and a shim that is present but broken is no longer caught
  before it lands in a host config.
- Narrow the resolution instead: only run the smoke test when the path
  came from an explicit flag or from beside the executable, never from
  `exec.LookPath`.

**Decision (2026-09-11, owner):** stop trusting PATH for the smoke test.

**Outcome (2026-09-11):** `ResolveShimBinary` now returns a `ShimSource`
(`ShimFromFlag`, `ShimBesideExecutable`, `ShimFromPath`) and
`VerifyShimBinary` executes the binary only when `src.Chosen()`. A
PATH-resolved shim is stat-checked and named, never run, and the CLI
says so rather than silently doing less. The targeted
`// nosemgrep: dangerous-exec-command` stays on the call that remains,
which is now reachable only from an operator's explicit choice.
Mutation-checked: dropping the guard makes the PATH-resolved binary
execute and fails the test on both assertions.

## The configuration surface has no drift guard at all

Audited 2026-09-11, after generating the MCP tool catalogue (#282). The
tool surface and the API contract are now generated from their sources.
The configuration surface is not guarded in either direction:

- `docs/install/env-reference.md` documents 34 `NOVAMEM_*` variables;
  the code reads 70. Nothing compares them.
- `docs/observability.md` documents seven `OTEL_*` variables and `grep`
  finds zero of them in the Go source (#277). An operator who sets them
  gets silence — the same failure shape as the `/api-docs` route that
  404'd for months.
- 36 variables are read by the server and documented nowhere.

Two existing guards have also rusted:

- The embedded skill copy is kept in step by an `rsync` a human has to
  remember, with a test that catches forgetting.
- `conformance/reference/tools.snapshot.json` is regenerated by
  `scripts/snapshot-tools.mjs`, **which does not exist** — it went with
  the TypeScript packages. The test's failure message names a script
  nobody can run.

Options:

- Add an env-var check to `doc-smoke`: every documented `NOVAMEM_*` must
  be read somewhere in the tree, and every variable the config reads must
  appear in the reference table. Cheapest, and it would have caught the
  OTEL page the day it went stale.
- Generate the env reference table from `config.go` the way the tool
  catalogue is generated from `tooldefs.json`, so the two cannot
  disagree at all.
- Fix the two rusted guards as well: replace the `rsync` with `go:embed`
  reaching the real directory (or a generator), and restore or delete
  `snapshot-tools.mjs` so the conformance snapshot is regenerable.
- Leave it; record the gaps as issues and move on.

## How should CI's BuildKit cache be fixed now that the Zot registry is gone?

Main's CI is red on `docker (amd64)` and `docker (arm64)` — infrastructure,
not code. The registry cache at `192.168.10.123` (Zot) no longer exists: no
Service holds that IP, and it is unreachable from both the ARC runners
(`dial tcp 192.168.10.123:443: i/o timeout`) and a workstation on the LAN.
A `nexus` namespace (192.168.10.131, ports 443/5000/8443) and a `buildkit`
namespace (192.168.10.130) were created the same day, so a migration
appears to be in flight.

The asymmetry matters: `cache-from` failures are tolerated, so **PR builds
pass**. Only main and tag builds run `cache-to`, and that export is fatal —
so main goes red _after_ the per-arch images are already pushed, which
skips the `manifest (multi-arch)` job (`needs: [docker]`) and leaves no
combined `sha-<short>` tag. That is why `sha-a368505` and `sha-11f976a`
404 while `sha-11f976a-arm64` exists and runs.

Verified on 2026-09-11 for #285 and #286: both were deployed to kw by
pointing the Deployment at `sha-<short>-arm64` directly, and conformance
passed 139/0/1. So this blocks the normal deploy path and leaves main
permanently red, but it is not blocking releases outright.

Options:

- Add `ignore-error=true` to the `cache-to` in `.github/workflows/ci.yml`.
  An optional build cache then cannot block publishing an image: a dead
  cache degrades to a slow build (~13 min cold vs ~2 min warm) instead of
  a red main and a missing manifest. Correct regardless of where the cache
  ultimately lives, and independent of the migration.
- Repoint `cache-from`/`cache-to` (and the `buildkitd-config-inline`
  insecure-registry entry) at the new Nexus registry at 192.168.10.131.
  Needs the intended repository path, whether it is reachable from the ARC
  runners, and its TLS posture.
- Both: repoint at Nexus _and_ make the export non-fatal, so the next
  registry move does not turn main red again.
- Drop the registry cache entirely and rely on cold builds.
