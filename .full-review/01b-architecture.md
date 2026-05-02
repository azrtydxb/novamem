# Architecture Review — novamem (`packages/server` core)

Scope: component boundaries, dependency management, API design, data model, design patterns, architectural consistency. Phase 1 of the comprehensive review. Findings are ordered by severity, then by area.

---

## Critical

### A1. `getEntry` accepts `projectId: "*"` escape hatch with no in-tree guard

File: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:847-864`

`WarmStore.getEntry()` documents and accepts `opts.projectId === "*"` to bypass the project membership check entirely. This is a deliberate back-door used "internally when the caller already enforced membership via a different path". Today it appears unused, but:

- It is a public method on a shared store.
- A future engine refactor could pass a user-controlled `project` value through unsanitized — e.g. if anyone ever wires the value of `req.body.project` straight into `opts.projectId` (not currently the case but the helper is shaped that way).
- Search/forget/neighbors/recent all funnel through `getEntry` and a single careless call site collapses cross-project isolation across all stores.

Architectural impact: Project is the security boundary for shared projects. A public method that disables that boundary on a magic string is a tripwire.

Recommendation: Remove the `"*"` branch outright. If a non-project-scoped lookup is ever needed (e.g. internal auditing), expose a separate, named method (`getEntryUnsafeAdmin`) that the type system makes obvious. Failing that, restrict it to a non-string sentinel (`Symbol`) so no JSON value can ever reach it.

---

### A2. Project-id collisions with collection-name parsing in cold store

File: `/Users/pascal/Development/novamem-1/packages/server/src/cold-store.ts:45-48,131-135,151-155`

The cold collection naming scheme is:

- Tenant: `novamem_<tenant>_<namespace>`
- Project: `novamem_p_<project>_<namespace>`

Cleanup uses `startsWith` prefix scans:

- `deleteAllForTenant("p")` would scan `novamem_p_*` — collide with **every** project-scoped collection.
- `deleteAllForTenant("p_<project>")` would also match a real project collection.
- A tenant id of `p` (or anything starting with `p_`) is currently allowed by `AdminCreateTenantBody` (`/^[a-z0-9][a-z0-9_-]*$/`).

Today no validation prevents `tenantId === "p"` or `tenantId === "p_foo"`. Result: deleting that tenant's cold data would also wipe every project-scoped collection.

Architectural impact: Cross-tenancy / cross-project data destruction during what should be a single-tenant tear-down. Critical-severity because the consequence is silent data loss (entire other tenants' cold vectors deleted).

Recommendation:

1. Reject tenant ids that start with `p_` (or `p` standalone) at the admin-create layer, with a backwards-compat audit that no such tenant already exists at startup.
2. Or — better — delimit the scheme so collisions are structurally impossible: `nvm_t_<tenant>_<ns>` vs `nvm_p_<project>_<ns>`. The leading `t_` makes prefix scans unambiguous.
3. While there, make the prefix-scan filter strict: `name === prefix + ns` per known namespace, or split on `_` and validate each segment.

---

### A3. Project-only filter is correct, but `addRelation` still trusts UNIQUE on `(from_id, to_id, relation)` only

File: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:916-931` and `schema.ts:177`

`memory_relations` has `UNIQUE (from_id, to_id, relation)` — global, not scoped to tenant or project. If two distinct projects ever share an entry id (impossible today because ULIDs are globally unique, but the constraint encodes the assumption), the upsert silently overwrites the other project's edge strength.

The `tenant_id` column on `memory_relations` defaults to `'public'` and has a NOT NULL — but a graph-link write between two project-scoped entries does pass `projectId`, while the `tenant_id` value persisted is the operating user's tenant, **not** the entry's owning tenant. For a shared cross-tenant project this means relation rows for the same project carry different `tenant_id`s depending on who hit `remember` — making the `tenant_id` filter on `forget()` (line 393–395) potentially miss relation rows authored by another member.

Architectural impact: cross-tenant project members can leave behind un-deletable relation rows on `forget()`. Not a confidentiality breach (relations are id-only), but a correctness bug that grows over time and is hard to reason about.

Recommendation:

- For project-scoped relations, scope the `forget()` cleanup on `(from_id = $1 OR to_id = $1) AND project_id = $2` instead of (or in addition to) `tenant_id`.
- Reconsider whether `memory_relations.tenant_id` should be NOT NULL when `project_id` is set — make the column nullable for project-scoped rows (mirroring `memory_entries`).

---

## High

### A4. `http.ts` is 974 LOC and owns auth, RBAC, project resolution, route handlers, dashboard CSP, MCP/SSE bridge

File: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts`

Single file holds: Zod schemas, auth hook (one big function with 6 distinct branches at lines 267–350), `resolveRequestProject`, `adminAuth`, all route handlers across 4 surface families (`/v1/*` data plane, `/v1/auth/*`, `/v1/me/*`, `/v1/admin/*`), the static SPA mount, and the SSE/MCP bridge.

Architectural impact: every surface change touches the same file. Tests are necessarily integration-shaped because there's no smaller seam to mock. New developers can't tell at a glance which routes are "data plane" vs "control plane" — the comment-only headers do the work that module boundaries should.

Recommendation:

- Split into modules under `packages/server/src/http/`:
  - `auth-hook.ts` (the onRequest hook + helpers)
  - `routes/data-plane.ts` (search/remember/recent/neighbors/forget/stats)
  - `routes/auth.ts` (login/logout/status/rotate-token)
  - `routes/me.ts` (self-service tokens, projects, metrics)
  - `routes/admin.ts` (tenants, users, tokens, metrics)
  - `routes/mcp-sse.ts`
- Fastify supports plugin composition via `fastify-plugin` — each module registers its own routes against a shared decorator. This also makes `resolveRequestProject` shareable as a request decorator.

---

### A5. Engine concentrates orchestration *and* SQL — partial Repository pattern leaks

File: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:252-339,378-425`

Most engine methods route through `this.warm.<method>()` (clean), but `decay`, `recent`, `forget`, and `reapOrphans` reach into `this.warm.pool.query(...)` with raw SQL. The warm store already exposes `listColdCandidates`, `getEntry`, `bumpHits`, etc. — adding three more methods (`writeDecayRun`, `selectRecent`, `forgetSql`, `selectOrphans`) would restore the boundary.

Architectural impact: Engine has two ways to talk to Postgres (typed Drizzle methods + raw `pool.query`). Schema changes (rename a column, add a tenant_id check) must be hunted across both layers. Tests must fake `warm.pool` for these paths even though `WarmStore` is otherwise the seam.

Recommendation: Move every `this.warm.pool.query(...)` call from `engine/index.ts` into a corresponding `WarmStore` method. The engine should not import `pg` semantics.

---

### A6. `recent()` SQL is hand-rolled with parameter-array bookkeeping that rebinds positional params

File: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:303-326`

`params` is built up but `LIMIT $2` is a fixed reference to the second slot — when the conditional branches push more params, the positional binding still works because `k` was pushed second and never moved. It's fragile: adding any param before `k` silently breaks the query. The `since` clause uses a forward-computed `$${params.length}` while `LIMIT` uses a fixed `$2`.

Architectural impact: Latent bug class. Hand-rolled positional SQL with mixed forward + fixed indices fails the next refactor.

Recommendation: Either (a) lift to Drizzle's typed query builder, or (b) introduce a tiny `bind()` helper (already used in `ftsSearch` as the `ph` closure) and use `bind(k)` everywhere instead of literal `$2`.

---

### A7. SSE-MCP session map is a memory-leak waiting to happen on backpressure / network-drop

File: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:921-944`

`sseTransports` map cleans up only on `reply.raw.on("close")`. If the underlying TCP connection half-closes, or if the SSE writer is GC'd before `close` fires (rare but observed in Fastify upgrades), the entry leaks. Each leaked session pins an `mcpServer` instance + its closures + the engine reference indirectly.

Architectural impact: Long-running deployments slowly accumulate dead sessions. With an admin-token rotation policy in front the count stays bounded, but it's still latent leak surface that no metric exposes.

Recommendation:

- Add an `error` listener alongside `close` that calls the same cleanup.
- Add a periodic sweeper (every minute) that drops entries whose `transport.sessionId` is closed.
- Expose `sseTransports.size` as a gauge so operators can spot drift.

---

### A8. The `ctxOrTenant: McpContext | string` union is a smell — and only the back-compat string path remains in tests

File: `/Users/pascal/Development/novamem-1/packages/server/src/mcp.ts:29-36,303-307`

The string form is used by exactly one caller — `startMcpStdio` at the bottom of the same file. Inside the same module, that's not "back-compat", it's "two ways to construct the same thing" — a YAGNI tax that every reader pays.

Architectural impact: Type unions on entry-point parameters force every caller and every test to think about the discrimination. The `tenantId` path also silently disables `project.list` / `project.create` (because `userId` is undefined) without telling stdio callers why.

Recommendation: Make `buildMcpServer` take `McpContext` only. Update `startMcpStdio` to pass `{ tenantId }`. Drop the `typeof ===` discriminator. If at some point you want the stdio launcher to also do project ops, give it a real `userId` source.

---

### A9. DDL ordering in `WarmStore.initialize()` aliases `ALTER TABLE memory_entries` *before* `CREATE TABLE memory_entries`

File: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:108-117`

Lines 108-114:

```sql
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS project_id text
ALTER TABLE memory_relations ADD COLUMN IF NOT EXISTS project_id text
ALTER TABLE memory_fts ADD COLUMN IF NOT EXISTS project_id text
ALTER TABLE cold_orphans ADD COLUMN IF NOT EXISTS project_id text
ALTER TABLE tenant_tokens ADD COLUMN IF NOT EXISTS project_id text
```

These run **before** the corresponding `CREATE TABLE IF NOT EXISTS memory_entries / memory_relations / memory_fts / cold_orphans` statements at lines 117, 142, 155, 168. On a *fresh* install the ALTERs error (table doesn't exist yet). The `for (const stmt of ddl)` loop has no try/catch, so this should fail.

Quick verify: it works only because Postgres `ADD COLUMN IF NOT EXISTS` against a missing table fails — but the integration tests pass in CI, which suggests either (a) the tests run against a database where the tables already exist from a prior run, or (b) the ordering is wrong but the failure is silent in some path.

Architectural impact: First-time deploys are at risk. Even if the order accidentally works on some Postgres versions, the *intent* — "ALTER for upgrade-in-place after CREATE for fresh install" — is inverted from the actual ordering.

Recommendation:

1. Verify behaviour on a clean DB (`DROP DATABASE` and re-run initialize).
2. Move every `ALTER TABLE … ADD COLUMN IF NOT EXISTS` block *after* the matching `CREATE TABLE IF NOT EXISTS`. The DDL list should be: tenants → users → sessions → projects → project_members → memory_entries (CREATE) → memory_entries (ALTERs) → memory_access → memory_relations (CREATE+ALTERs) → memory_fts (CREATE+ALTERs) → cold_orphans (CREATE+ALTERs) → tenant_tokens (CREATE+ALTERs) → decay_runs.
3. Long term, replace this in-code DDL with `drizzle-kit` migrations checked into the repo and run via a startup migration phase. The current "DDL list in TypeScript" pattern is the well-known on-ramp to schema drift.

---

### A10. `memory_entries.tenant_id` is declared NOT NULL with a default, yet project-scoped rows store the *creator's* tenant

File: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:760-769` and engine `remember` at `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:97-125`

When a cross-tenant project member calls `remember`, the row gets `(tenant_id = caller's tenant, project_id = project)`. Two observations:

1. The `tenant_id` value is now meaningful only for the legacy "no project" scope. With a project, it's just trivia.
2. `getEntry` correctly ignores `tenant_id` when `projectId` is set — but `forget`, `deleteTenant`, and the gauge-source queries in `main.ts:90-103` still group by `tenant_id`. So a project entry created by user-A (tenant `a`) won't appear in user-B's (tenant `b`) per-tenant warm-count gauge, **even though both can read it**. Operators see incorrect counts.

Architectural impact: Multi-tenant accounting and per-tenant decay/promotion stats are wrong for shared projects.

Recommendation:

- Project-scoped rows should either (a) carry the *project owner's* tenant for billing attribution (consistent with `projects.owner_tenant_id`), or (b) carry NULL for `tenant_id`. Decide and stick to it.
- Update gauge queries to count "warm entries the tenant can read" rather than "warm entries with `tenant_id = $1`". Probably:
  ```sql
  WHERE (tenant_id = $1 AND project_id IS NULL)
     OR project_id IN (SELECT project_id FROM project_members
                          JOIN users ON users.id = project_members.user_id
                         WHERE users.tenant_id = $1)
  ```

---

### A11. `forget()` filters by `tenant_id` even for project-scoped entries — and silently fails to delete

File: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:386-396`

```js
"DELETE FROM memory_entries WHERE id = $1 AND tenant_id = $2", [id, tenantId]
```

For a cross-tenant project, the entry's `tenant_id` is whoever first wrote it. If user-B (different tenant) tries to `forget` it, `getEntry` returns the row (because the project filter passes), the cold delete runs, but the warm DELETE matches zero rows — the entry survives, the cold vector is gone. Later searches return ids without matching warm content (which the engine handles by skipping — but the inconsistency is silent).

Architectural impact: forget on shared projects is not idempotent across members. The "project IS the access boundary" invariant is violated by a tenant-scoped DELETE.

Recommendation: When `e.projectId !== null`, the DELETEs should scope by `project_id = $2` instead of `tenant_id = $2`. Same applies to `memory_fts`, `memory_relations`, `memory_access`. The `getEntry` membership check is the access gate; the DELETE just needs to be unambiguous.

---

## Medium

### A12. Three different ways to authorize a request — admin-token, session, tenant-bearer — all resolved in one hook with implicit precedence

File: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:267-350`

The auth hook is functionally correct but the precedence isn't documented and the branching is order-dependent. Specifically:

- A request with both a session bearer (`ns_…`) and the legacy admin token would be admitted as the admin (because `adminAuth` checks `dashUser?.role === "admin"` first), but as the session user for `/v1/me/*`. Mixing bearers is ill-defined.
- The "skip list" of public paths is hard-coded with `startsWith` checks; `req.url === "/v1/auth/login"` is fine but `req.url.startsWith("/api-docs/")` accepts anything appended.

Recommendation:

- Replace the URL-prefix skip list with a per-route `config: { public: true }` annotation on each Fastify route. The hook reads `req.routeOptions.config.public` and short-circuits.
- Document the bearer-precedence rule in code: only one Authorization header is honoured per request, and the `ns_` / `nm_` prefix is the single source of truth.
- Consider three separate hooks (data plane, dashboard, admin) registered with `app.register(prefix: "/v1/me")` etc., rather than one mega-hook that branches by URL prefix.

---

### A13. `resolveRequestProject` is duplicated in HTTP and MCP

Files: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:419-449` and `/Users/pascal/Development/novamem-1/packages/server/src/mcp.ts:165-184`

Two copies of the same rule with minor formatting differences. When the rule changes (e.g. allow admin bearers to specify any project), both files must move in lockstep.

Recommendation: Extract to `packages/server/src/auth/project-scope.ts` with a pure function `resolveRequestProject({ bearerProjectId, requestedProject }): { ok: true, projectId } | { ok: false, status, error }`. Both transports adapt the result.

---

### A14. `engine.deleteProject` does not enforce ownership; `engine.deleteTenant` doesn't either

Files: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:498-566`

The engine docstring on `deleteProject` says "Does NOT enforce permissions — the HTTP layer must verify the caller is the project owner". This is an out-of-band invariant. The MCP transport currently doesn't expose `project.delete`, so the gap is closed by absence — but the *engine API* permits any caller to delete any project. Adding a future MCP tool, a CLI binary, or a background worker that consumes this method risks bypassing the only check.

Recommendation: Push the ownership check down into the engine method itself, taking a `requesterUserId` argument. The HTTP handler passes `u.id`; the engine returns `{ deleted: false, reason: "not owner" }` if it doesn't match.

---

### A15. Endpoint design mixes verbs into URLs — partially RESTful, partially RPC

File: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts`

The `/v1/*` data plane is RPC-shaped (`POST /v1/search`, `POST /v1/remember`, `POST /v1/forget`) — defensible for a memory service. But the control plane mixes:

- `POST /v1/admin/tenants/:id/tokens` (RESTful)
- `POST /v1/admin/tokens/revoke` (RPC) — and there's also `POST /v1/admin/tenants/:tenantId/tokens/:hash/revoke` (semi-REST)
- `POST /v1/me/tokens/:hash/revoke` — verb in the URL

Architectural impact: API design is inconsistent. Two ways to revoke a token, with different URL shapes. Clients have to learn both.

Recommendation:

- Drop `POST /v1/admin/tokens/revoke` (the un-scoped one) — it accepts a plaintext token, which is also a security smell (plaintext travels through the request log).
- Settle on `DELETE /v1/admin/tenants/:tenantId/tokens/:hash` and `DELETE /v1/me/tokens/:hash` as the single revocation surface. POST-with-verb only when an action is genuinely non-idempotent.

---

### A16. Error contracts are inconsistent across handlers

The reply shapes vary: `{ error: "..." }` is the dominant form, but some endpoints add fields:
- `{ added: true, userId, username }` (line 773)
- `{ deleted: true, ... }` from engine
- 401s sometimes return `{ error: "unauthorized" }`, sometimes nothing (rate-limit plugin defaults).

There is no top-level error envelope (`{ error: { code, message, details } }`) and no error code that survives translation into the OpenAPI doc.

Recommendation: Define an error envelope in `types.ts`:
```ts
type ErrorResponse = { error: { code: string; message: string; details?: unknown } };
```
Wire a Fastify error handler that converts thrown `HttpError`s + Zod errors into that shape uniformly. Update the OpenAPI doc to reference it.

---

### A17. `WarmStore` exposes both `db` (Drizzle) and `pool` (raw pg) as public — no encapsulation

File: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:34-44`

Both are read-only, but callers (engine + main.ts gauges) reach into both. This is the proximate cause of A5.

Recommendation: Mark both `private` and have `WarmStore` expose every operation as a typed method. If short-term you need to keep `pool` accessible for operational scripts, expose a `runRawQuery<T>(sql, params)` method that *requires* a comment justifying each use — the friction reduces drive-by `pool.query` reaches.

---

### A18. The `effectiveDays` decay scaling has a subtle off-by-7 hidden in two places

File: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:266-275` and `:81`

Promotion (line 81) uses `effectiveDays(preBump.hits + 1)` directly, in days. Decay (line 269) does `(effectiveDays(c.hits) / 7) * baseDays` to scale by the override base. If a caller passes `effectiveDaysOverride: 7`, the two paths agree. If they pass `effectiveDaysOverride: 14`, demotion is computed against doubled lifespans but **promotion** stays at the unscaled formula. They re-promote and re-demote in alternation.

Architectural impact: The two halves of the cold/warm tier are governed by two different lifespan formulas the moment an operator overrides `effectiveDays`. Decay-run determinism is broken.

Recommendation: Centralise the lifespan calculation: `lifespanDays(hits, baseDays = 7)` in `hybrid-search.ts`. Both `maybePromote` and `decay` call it with the same `baseDays`. The base flows from `EngineConfig.defaultEffectiveDays` (or per-call override) into both.

---

### A19. `metrics` is bound at the top-level `MemoryEngine` constructor but mutated from many call-sites — observation-aspect not separated

The engine constructor takes a `metrics` collector. Every hot path then sprinkles `this.metrics?.recordX(...)` calls. This is the standard ad-hoc instrumentation anti-pattern (counter-litter).

Architectural impact: Adding a new metric requires touching every engine method. Removing one requires audit. Tests must check both behaviour and instrumentation. New transports (e.g. a job runner) need to remember to instrument the same way.

Recommendation: Decorator pattern. Define `MemoryEngine` interface; provide `MeteredEngine` that wraps another engine and emits metrics around each call. `main.ts` chooses whether to wrap. Engine logic stays metric-free.

---

## Low

### A20. `WarmStore` re-exports `asc, desc, eq, and, sql` from drizzle-orm as instance fields

File: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:973-977`

Re-exporting library functions as instance properties confuses ownership ("is `warm.eq` mine or drizzle's?") and prevents tree-shaking. If callers need them they can `import { asc, desc, eq } from "drizzle-orm"` directly.

Recommendation: Delete those five lines; fix any caller to import directly.

### A21. `seenCollections` cache in `ColdStore` never invalidates on external drops

File: `/Users/pascal/Development/novamem-1/packages/server/src/cold-store.ts:26,50-65`

If Qdrant collections are dropped out-of-band (operator action, disaster recovery), the cached `seenCollections` makes the cold store skip re-creation on the next write — and the upsert fails. Manual restart required.

Recommendation: Either drop the cache (one extra `getCollections` call per write is cheap given collection count is bounded), or invalidate the cache on every upsert error.

### A22. `engine/hybrid-search.ts` is referenced but not co-located in the review files

The engine imports `DEFAULT_WEIGHTS, effectiveDays, fuse` from `./hybrid-search.js`. This module is not visible in the directory listing under `src/engine/`. Either there is an index re-export trick or the file is named differently. Worth verifying the test suite covers the fuse weighting math.

Recommendation: confirm `packages/server/src/engine/hybrid-search.ts` exists; if not, fix the imports.

### A23. OpenAPI doc is hand-written (510 LOC) and drifts from Zod schemas

File: `/Users/pascal/Development/novamem-1/packages/server/src/openapi.ts`

The Fastify-Swagger plugin is registered in `static` mode pointing at this hand-written object. Every Zod schema in `http.ts` has a parallel description here. Drift is inevitable as features ship.

Recommendation: Adopt `zod-to-openapi` (or migrate to Fastify route schemas with `fastify-zod` / `fastify-type-provider-zod`). One source of truth.

---

## Summary by Severity

- Critical: 3 (project-id collisions in cold collections, magic-string project bypass, project-only relation cleanup gap)
- High: 8 (HTTP layer size, engine raw SQL leakage, recent-SQL fragility, SSE leak, MCP union smell, DDL ordering, tenant_id semantics on shared projects, forget tenant-scoping bug)
- Medium: 8 (auth-hook coupling, project-resolve duplication, ownership checks in engine, REST/RPC mix, error envelope, warm-store encapsulation, decay base inconsistency, metrics decoration)
- Low: 4 (drizzle re-exports, qdrant cache, hybrid-search file, OpenAPI drift)

## Strict-Mode Recommendation

The three Critical findings (A1, A2, A3 / A11) are all in the project-isolation contract. A2 in particular is a data-loss vector that triggers under realistic operator actions (deleting a tenant whose id starts with `p`). I would block at checkpoint 1 until A2 is fixed (one-line validation tightening + collision audit on existing tenant ids), and create issues for A1 and A11. The remaining Highs are quality-of-architecture concerns rather than safety.
