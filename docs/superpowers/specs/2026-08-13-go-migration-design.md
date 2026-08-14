# Gradual Go migration of novamem-server — design

**Date:** 2026-08-13
**Status:** Implemented. All eight slices are in `go/`, the parity audit
is at [go-parity-audit.md](../../architecture/go-parity-audit.md), and
the full conformance suite is green against the Go server (102 passed,
1 skipped, 0 failed — the skip is the write-quota 429, which needs a
per-user quota low enough to starve the rest of the run and so passes
in a dedicated run). What remains is the cleanup phase below: the Go
server becoming the novamem-bench default, then deleting
`packages/server`.

## Goal

A Go implementation of `novamem-server` that is a drop-in replacement for
the TypeScript server: same HTTP/MCP API, same Postgres schema, same
config surface (env vars), shipped as a single static binary / distroless
image. Built in vertical slices, each validated by a shared black-box
conformance suite against the `novamem-bench` deployment on the kw
cluster.

**Drivers:** performance/footprint, single-static-binary distribution,
and long-term maintainability in Go — all three.

**Hard constraint:** all development, testing, and deployment for this
migration happen exclusively on the `novamem-bench` deployment on the
kw cluster. No other deployment is in scope, referenced, or touched —
production rollout is entirely outside this migration and is a separate
operator decision made after the fact.

## Migration strategy

Contract-first parallel build (chosen over engine-out extraction and
big-bang rewrite):

- Freeze the external contracts (OpenAPI, MCP tool schemas, Postgres
  schema) as reference artifacts.
- Build a black-box conformance suite that runs against any novamem URL;
  a green run against the TS server is the baseline oracle.
- Implement the Go server in vertical slices; each slice ends with its
  portion of the conformance suite green against the Go server.
- The TS server keeps running throughout as the reference oracle; both
  servers can be pointed at the same seeded DB for differential tests.

Rejected alternatives:

- **Engine-out extraction** (Go engine called from TS via RPC): builds a
  throwaway TS↔Go boundary; the single-binary payoff arrives last.
- **Big-bang rewrite on a branch:** months with no shippable artifact,
  no incremental review, and drift against a TS server still receiving
  features.

## 1. Repo layout

New top-level `go/` directory in the monorepo:

```
go/
  go.mod                       module github.com/azrtydxb/novamem/go
  cmd/novamem-server/          main
  internal/
    config/                    env-var loader, same variables as TS
    httpapi/                   routes, middleware, request context
    auth/                      sessions, bearer tokens, role gates
    warmstore/                 Postgres warm tier
    coldstore/                 pgvector + Qdrant cold tier
    engine/                    hybrid search, rerank, fact extraction,
                               dream consolidation, decay
    mcp/                       MCP tools + streamable/SSE transports
    jobs/                      background loops with single-flight guards
    otel/                      tracing/metrics wiring
```

Unchanged and staying TypeScript/npm permanently: `packages/client`,
`packages/mcp` (shim), `packages/init`, `packages/admin-ui` (Preact).
The admin-ui build output is embedded into the Go binary via `go:embed`,
replacing `@fastify/static`.

## 2. Frozen contracts

Three artifacts define "correct":

1. **OpenAPI spec** — generated today by `docs:api`; checked in as the
   reference the Go server must match (paths, status codes, error
   shapes).
2. **MCP tool schemas** — all 21 tools (14 `memory_*` + 7 `project_*`
   in `mcp-tools.ts`) and both transports (streamable
   HTTP and legacy SSE), including the behaviors enforced by
   `mcp-spec-guards.ts`.
3. **Postgres schema** — Drizzle migrations remain the single source of
   truth for the duration of the migration. The Go server runs against
   the schema but does not own migrations; at startup it checks the
   drizzle migration journal and refuses to start against an unknown
   version. Moving migration ownership to Go is a post-parity task.

## 3. Conformance suite (built first, before any Go code)

A black-box suite in `packages/conformance` (TypeScript, so it can reuse
existing test helpers) that takes `NOVAMEM_URL` plus credentials and
exercises the full API surface:

- data plane: `search`, `remember`, `recent`, `neighbors`, `forget`,
  projects, TTL (`expiresAt`), write quotas, changelog
- `/v1/me/*` user-scoped reads, export/import
- admin plane: metrics, prom endpoint, audit log, token revoke
- auth flows: none/bearer/user modes, rotate-token, project-confined
  tokens, role gates, read-only tokens
- MCP over both transports, all tools, spec-guard behaviors

The suite runs against the TS server first; that green run is the
baseline. Every Go slice must keep its portion green.

**Differential tests** for subtle behavior (hybrid search ranking,
rerank, decay scoring): seed the same DB, issue the same query to both
servers, compare ranked results within a stated tolerance rather than
exact equality.

## 4. Auth

Go implements auth natively over the **existing Better Auth tables** —
no Better Auth port, no separate identity server (Ory/Zitadel/etc. were
rejected: they break the single-binary goal and vastly exceed the used
surface).

Surface actually in use today (146-line config in
`auth-betterauth.ts`): email+password, sessions, admin role plugin, JWT
plugin. In Go:

- scrypt password verification via `x/crypto/scrypt`, matching Better
  Auth's stored hash format — existing passwords keep working.
  Fallback if format compatibility proves nasty: verify-or-upgrade on
  first login.
- session cookie issuance/validation against the existing session table
- admin role gate; JWT endpoints
- all novamem-native auth ports mechanically: `nm_` bearer tokens,
  rotate-token, project-confined tokens, tenant mode, shared operator
  token, constant-time compares, per-account attempt limiter

Result at cutover: no re-login, no token re-issue, no schema break.

## 5. Embeddings and LLM calls

**Decision (owner, 2026-08-14):** the Go server never embeds a model in
process. `NOVAMEM_EMBEDDINGS_PROVIDER=local-transformers` is refused at
startup with a message pointing at the API-endpoint path; deployments
that want fully-local embeddings run the model behind an
OpenAI-compatible endpoint and point `NOVAMEM_EMBEDDINGS_ENDPOINT` at
it. The TypeScript server's in-process path is left as it is. This is
the one intentional behavioural difference in an otherwise 100%-parity
port, and it exists to keep the single static binary.

Everything else that calls a model — fact extraction, the observer /
reflector, and query decomposition — IS ported, because those already
call external endpoints in both servers. (An earlier audit misfiled
them as out of scope; they are in.)


External OpenAI-compatible endpoints only — embeddings, reranker, and
fact-extractor/dream LLM calls. No in-process ONNX (cgo would compromise
static builds and cross-compilation). Config keeps the same env vars.
The in-process `@xenova/transformers` path is dropped in the Go server;
self-hosters who want fully-local embeddings run one additional small
container (documented).

## 6. Slice order

Each slice is one or more normal PRs and ends with its conformance
portion green against the Go server on novamem-bench:

1. **Skeleton** — config loader (same env vars), health/status
   endpoints, OTel wiring, structured logging, graceful shutdown,
   drizzle migration-version startup check.
2. **Warm store + data plane CRUD** — `remember`, `recent`, `forget`,
   projects, TTL, quotas, changelog; `none` and `bearer` auth modes.
   *(Go server becomes genuinely usable for single-user bearer setups
   here.)*
3. **Cold store + search** — pgvector first, Qdrant second; embeddings
   client; hybrid search + rerank (`search`, `neighbors`); differential
   ranking tests.
4. **MCP** — streamable transport with all 21 tools, then legacy SSE.
5. **User mode** — native auth over Better Auth tables, `/v1/me/*`,
   dashboard static serving via `go:embed`.
6. **Background jobs** — decay/reap loop, dream consolidation, async
   enrichment, metrics flush; per-timer single-flight guards as today.
7. **Admin plane** — metrics, prom, audit log, token revoke,
   export/import.
8. **Parity audit** — full conformance + differential run, load
   comparison using the existing bench harness, soak on novamem-bench.

## 7. Feature freeze policy

From slice 2 onward:

- every new server feature lands with a conformance test;
- once a feature's area is ported, new changes in that area land in
  **both** servers;
- when the Go server becomes the default on novamem-bench, new features
  become Go-first and the TS server enters maintenance mode (bugfixes
  only) until the cleanup phase removes it.

Without this, parity is a moving target and the migration never
converges.

## 8. Testing, CI, and release

- Go unit tests per package (`go test ./...`).
- Conformance suite in CI against a dockerized Go server +
  Postgres/pgvector; periodically against the TS server too, to keep
  the oracle honest.
- Cluster testing via the existing local-image deploy flow to
  novamem-bench.
- Release artifacts once slice 4 lands: cross-compiled binaries
  (linux/amd64, linux/arm64, darwin/arm64) and a distroless image via
  goreleaser. Server releases keep the existing manual `vX.Y.Z` tag +
  GitHub release flow.

## Error handling

The Go server must reproduce the TS server's error contract: same
status codes and JSON error shapes as documented in the OpenAPI spec
(e.g. 403 `"token is confined to its project"`, 401s from the auth
hooks, quota 429s). The conformance suite asserts error shapes, not
just happy paths.

## Definition of done and cleanup

**Per slice, "done" means all of:**

1. Conformance portion green against the Go server (plus differential
   tests where applicable) — no test waivers, no partial acceptance.
2. Actually deployed to novamem-bench via the standard deploy flow and
   exercised live (real requests through real clients/integrations, not
   just CI).
3. Documented: user-facing docs updated where behavior is now served by
   Go, and the slice's design decisions recorded.

A slice that fails any of the three is not merged as "done" — there is
no "mostly works, fix later" state.

**Final cleanup phase (after the slice 8 parity audit passes and the Go
server is the default on novamem-bench):**

- Delete `packages/server` (the TS implementation) entirely.
- Delete the in-process Xenova embedding path and its dependencies.
- Move Drizzle migration ownership to the Go tree (or a Go-native
  migration tool) and delete the drizzle-kit tooling.
- Remove TS-server-only CI jobs, build scripts, and Docker stages.
- Sweep docs for references to the TS server.

The TS server is kept **whole** until this phase (it is the conformance
oracle); it is then removed in one
dedicated cleanup, not left as a fallback. No backwards-compatibility
shims, dual code paths, or "legacy mode" flags survive the migration —
the git history is the archive.

## Non-goals

- No rewrite of `client` / `mcp` / `init` npm packages.
- No admin-ui rewrite (Preact stays; it is embedded, not ported).
- No schema changes for their own sake; no auth redesign.
- No in-process embedding runtime in Go.
- No deployment target other than novamem-bench on the kw cluster.
