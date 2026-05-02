# Code Quality & Architecture Review — novamem

Scope: whole-repo, with focus on the recently-added project-isolation /
session-auth / hand-rolled OpenAPI work. Findings are ordered by severity,
not file. ~20 actionable items.

---

## Critical

### C1. Dashboard auth hook does not verify session expiry — silent reliance on DB UPDATE

**Severity**: Critical
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:302-305`,
`/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:529-558`

`resolveSession` *does* gate on `expires_at > now()` in the UPDATE, but the auth
hook treats any non-null return as "session valid". That's currently safe, but
two adjacent issues make it brittle:

1. `revokeSession` performs `DELETE FROM sessions WHERE token_hash = $1` —
   so revoked sessions correctly return null. **However, there is no path that
   updates `expires_at`** anywhere. `last_seen_at` is touched per request, but
   the absolute TTL is never extended *or* shortened. Dashboard sessions live
   exactly 24 hours from issuance regardless of activity. That's likely
   intentional (the comment says so), but the comment in `auth.ts:14-17` says
   "Refreshed on every request via the warm-store's `last_seen_at` update" —
   which is misleading since the session expiry is **not** refreshed.

2. There is no garbage-collection sweep for expired sessions — they accumulate
   forever. A long-lived deployment that goes through many login cycles will
   slowly grow the `sessions` table without bound. Cheap to fix; high blast
   radius if missed.

**Fix**:
```ts
// in main.ts decay/reap loop, also:
await warm.pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
// and reconcile the auth.ts comment to say "session is valid for 24h from
// creation; activity does not extend the TTL".
```

### C2. Project isolation: tenant id is *not* checked when project is set, but project id is unauthenticated on getEntry

**Severity**: Critical
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:847-864` (`getEntry`),
`/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:209,357,383`

`getEntry`'s contract is documented: "When `projectId` is supplied, the entry
must also match that project (or be tenant-wide if `projectId` is null)."

But `resolveRequestProject` in http.ts (line 426-449) only verifies the
*bearer*'s project against the body's project. It does **not** verify that
the requesting tenant is allowed to operate on `bearerProject` at all. The
fact that the bearer carries the project id is the access proof — there is
no separate membership check on hot data-plane paths (search/remember/forget
/recent/neighbors).

That's correct *only as long as* tenant tokens can never be minted with a
project id the user is not a member of. Today, `POST /v1/me/tokens` (http.ts
line 681-685) does check `getProjectMembership` before minting. Good.

But: `POST /v1/admin/tenants/:id/tokens` (line 810-823) lets an admin mint a
tenant-wide token (project_id stays null) — that's fine. There is **no admin
path that mints a project-scoped token** — also fine, prevents the foot-gun.

However, when membership is later revoked (`removeProjectMember`), already-
minted project tokens stay valid until manually revoked. **Project removal
does not revoke project-scoped tokens issued to that user.** A removed member
keeps full read/write access via their previously-minted token until it's
manually revoked or it expires (tenant tokens never expire).

**Fix**: Either (a) `removeProjectMember` should also `UPDATE tenant_tokens
SET revoked_at = now() WHERE project_id = $1 AND created_by_user_id = $2`,
or (b) add a per-request membership check at `resolveRequestProject` time
when the bearer carries a project id (cached, since the bearer's `created_by_
user_id` is already on the token row). Option (a) is cheap; do that.

```ts
// in WarmStore.removeProjectMember, after DELETE:
await client.query(
  `UPDATE tenant_tokens SET revoked_at = now()
    WHERE project_id = $1 AND created_by_user_id = $2 AND revoked_at IS NULL`,
  [projectId, userId],
);
```

---

## High

### H1. `http.ts` is doing far too much (974 LOC) — auth hook + 30 routes + RBAC + SSE wiring

**Severity**: High
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts` (entire file)

The single `buildHttpServer` function is 770+ lines. It mixes:

- Fastify boot + plugin registration
- The auth `onRequest` hook (~85 lines, four distinct request classes)
- Static asset / CSP wiring for the SPA
- 7 data-plane routes
- 13 control-plane routes (auth + me + admin)
- SSE/MCP transport

This is not a "router file" anymore — it's the entire HTTP layer. Two
near-term consequences:

- Every test stub now boots all of it: `http.test.ts` is 1268 lines.
- The auth hook's branching (line 267-350) is the single highest-risk piece
  of code in the repo (anything that mis-routes is a security incident),
  and it lives buried in the middle of a thousand-line function.

**Fix**: Decompose into modules. Suggested split:

```
src/http/
  index.ts              — buildHttpServer, plugin registration, listen wiring
  auth-hook.ts          — the onRequest tenant + session resolution
  routes/
    data.ts             — /v1/{search,remember,forget,recent,neighbors,decay,reap-orphans,stats}
    auth.ts             — /v1/auth/*
    me.ts               — /v1/me/*
    admin.ts            — /v1/admin/*
    sse.ts              — /mcp/sse + /mcp/messages
  static.ts             — admin SPA mount + CSP + favicon
  resolve-project.ts    — the helper, exported, with its own unit tests
```

The `resolveRequestProject` helper especially deserves its own file +
tests — it's a security-sensitive 24-liner with no direct test coverage
(it's only exercised end-to-end via http.test.ts).

### H2. SQL scope-clause builder in `ftsSearch` is fragile and dangerous

**Severity**: High
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:797-836`

The current implementation:

```ts
const scopeClause = isProject
  ? `project_id = ${ph(args.projectId)}`
  : `tenant_id = ${ph(args.tenantId)} AND project_id IS NULL`;
// …
const fScopeClause = scopeClause.replace(/(project_id|tenant_id)/g, "f.$1");
```

Three problems:

1. **String regex replacement on SQL fragments.** If anyone ever adds a
   comment, alias, or new column whose name contains `project_id` or
   `tenant_id` (e.g. `owner_tenant_id`), the regex will silently corrupt
   the query. The alias-stripping pattern is fundamentally a maintenance
   booby-trap.
2. **Two SQL templates for the same query**, branching on `useAgent`.
   This is the kind of duplication that drifts (it already drifted: the
   join variant uses `f.tsv` but the no-join variant uses bare `tsv`,
   and the column list differs).
3. **No prepared statement reuse.** Each call rebuilds a string + a fresh
   parameter array, defeating any pg server-side plan cache.

**Fix**: Pick a canonical form (always join `memory_fts f LEFT JOIN
memory_entries e`, even when no agent filter) so there's one query template.
Then use Drizzle's query builder or pre-bind with explicit aliasing.

```ts
const conditions = [
  eq(memoryFts.namespace, args.namespace),
  sql`${memoryFts.tsv} @@ plainto_tsquery('english', ${args.query})`,
];
if (args.projectId != null) {
  conditions.push(eq(memoryFts.projectId, args.projectId));
} else {
  conditions.push(eq(memoryFts.tenantId, args.tenantId));
  conditions.push(isNull(memoryFts.projectId));
}
if (args.agentName !== undefined) {
  conditions.push(args.agentName == null
    ? isNull(memoryEntries.agentName)
    : eq(memoryEntries.agentName, args.agentName));
}
```

### H3. Project-vs-tenant scoping logic is duplicated across four stores and will drift

**Severity**: High
**Files**:
- `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:847-864` (getEntry)
- `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:797-836` (ftsSearch)
- `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:300-316` (recent inline SQL)
- `/Users/pascal/Development/novamem-1/packages/server/src/cold-store.ts:45-48` (collectionFor)
- `/Users/pascal/Development/novamem-1/packages/server/src/graph-store.ts:84-101` (neighbors)

Each implements the same rule — *"if projectId is set, scope by project_id
only; otherwise scope by tenant_id with project_id IS NULL"* — but expressed
differently:

- WarmStore: SQL `WHERE` builders (raw + Drizzle)
- ColdStore: collection naming `novamem_p_<project>_*` vs `novamem_<tenant>_*`
- GraphStore: Cypher `{tenant: $t, project: $p}` with empty-string sentinel
- engine.recent: yet another raw SQL builder

If the rule changes (e.g. someone adds a "project + tenant must both match"
assertion for defense-in-depth), there are four places to keep in sync, no
automated test that asserts they agree, and the engine.recent variant doesn't
go through `WarmStore.ftsSearch` at all so it cannot benefit from any fix
applied there.

**Fix**: Factor out a single `Scope` value-object:

```ts
// src/scope.ts
export type Scope =
  | { kind: "tenant-wide"; tenantId: string }
  | { kind: "project"; projectId: string };

export function scopeFromRequest(tenantId: string, projectId: string | null): Scope {
  return projectId == null
    ? { kind: "tenant-wide", tenantId }
    : { kind: "project", projectId };
}
```

…and have each store accept `Scope` instead of `(tenantId, projectId | null)`.
Then `getEntry`, `ftsSearch`, `recent`, `cold.collectionFor`, and
`graph.neighbors` all consume the same shape and can't drift.

### H4. `engine.recent` has inline SQL that bypasses the warm-store's encapsulation

**Severity**: High
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:303-326`

The engine layer reaches into `this.warm.pool` to issue raw SQL against
`memory_entries`. Every other store operation goes through a method on
`WarmStore`. This:

- Means `recent()` doesn't appear in the WarmStore class surface (so the
  fakes have to recreate the SQL pattern in `test-fakes.ts:48-80`, parsing
  the raw query string with substring matches — see also F2).
- Hides a fourth project/tenant scoping implementation (per H3) inside the
  engine.
- Couples engine to `pool.query` parameter ordering — touching the SQL
  silently breaks the fake.

**Fix**: Move to `WarmStore.recent({ tenantId, projectId, namespace, since,
k })` returning typed rows. Engine then has zero raw SQL — every store call
is a method.

### H5. `test-fakes.ts` parses production SQL with string matching — extremely fragile

**Severity**: High
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/test-fakes.ts:48-200`

`FakeWarmStore.pool.query` switches on `sql.includes(...)` and
`sql.startsWith(...)` substrings to dispatch to in-memory fake
implementations (lines 50, 82, 87, 92-108, 110, 132, 155, 172, 181, 185, 192,
199 — twelve fragile string matches). At line 199 it throws on any unmatched
SQL — but the matches are not anchored, are sensitive to whitespace, and
duplicate the production SQL semantics in JavaScript.

This is 822 lines of test infrastructure that is itself a liability:

- Any production SQL change that doesn't perfectly preserve a substring
  silently re-routes through the wrong fake handler or trips the throw.
- The fake's `recent()` substring-match (line 50) requires the production
  SQL to keep the literal `"namespace = $1"` text; renaming the column or
  reordering parameters breaks every test that calls recent().
- Two independent isolation rules now exist: the real store's, and the
  fakes' — see test-fakes.ts:62-65 for the recent() implementation,
  test-fakes.ts:241-249 for ftsSearch, test-fakes.ts:262-274 for getEntry.
  These are all hand-restated isolation rules. If H3's `Scope` value-object
  is adopted and the store API changes from `(tenantId, projectId | null)`
  → `Scope`, the fakes break in lockstep — that's actually desirable.

**Fix**: Two complementary approaches —
1. Move every raw `pool.query` in `engine/` and `warm-store/` into named
   `WarmStore` methods (see H4), so the fake only needs to implement
   `WarmStore`'s public method surface, not its SQL.
2. Use a real Postgres in tests via testcontainers + schema migrations.
   The integration test (`packages/server/tests/integration.test.ts`)
   already exists; the unit tests should either drop down to that level
   or stop testing SQL-level behaviour at all.

### H6. Graph store silently swallows errors on tenant + project purge

**Severity**: High
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/graph-store.ts:113-135`

```ts
async removeAllForTenant(tenantId: string): Promise<void> {
  if (!this.graph || !this.connected) return;
  try {
    await this.graph.query("MATCH (n:Memory {tenant: $tenant}) DETACH DELETE n", ...);
  } catch {
    // Best-effort — the warm/cold purge already succeeded.
  }
}
```

The catch is silent — no logger reference is captured, no metric, no
attempt to surface a failure to the caller. The engine's `deleteTenant` /
`deleteProject` path (engine/index.ts:514-528, 549-559) sets
`graphCleared = true` only if `removeAllForTenant` does not throw —
but `removeAllForTenant` never throws (it swallows). So `graphCleared`
is always reported as `true` whenever the graph is connected, even if
the Cypher MATCH/DELETE failed. Operators relying on this in audit
output will be misled.

**Fix**: Let the function throw, or at minimum log:

```ts
async removeAllForTenant(tenantId: string): Promise<void> {
  if (!this.graph || !this.connected) return;
  // Don't catch here — let the engine layer log + report graphCleared:false.
  await this.graph.query("MATCH (n:Memory {tenant: $tenant}) DETACH DELETE n", {
    params: { tenant: tenantId },
  });
}
```

The engine already wraps both calls in try/catch with proper logging
(engine/index.ts:516-521, 553-558), so this strictly improves observability.

### H7. SSE/MCP message endpoint has no auth on POST — relies entirely on sessionId

**Severity**: High
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:946-952`

```ts
app.post("/mcp/messages", async (req, reply) => {
  const sessionId = (req.query as { sessionId?: string }).sessionId;
  if (!sessionId) return reply.code(400).send({ error: "missing sessionId" });
  const session = sseTransports.get(sessionId);
  if (!session) return reply.code(404).send({ error: "unknown sessionId" });
  await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
});
```

The auth hook (line 267) does run on `/mcp/messages` first. In `tenant`
mode it requires a bearer; that bearer's tenant must match the session's
captured tenant. But the hook does not enforce that match — the session's
tenantId is captured at SSE handshake time and used for all subsequent
messages, but a different bearer could POST with a known sessionId and
have its messages dispatched against the *first* bearer's tenant.

In practice: tenant A starts an SSE session. Tenant B — with a valid
tenant-B bearer — discovers the sessionId (it's in the URL query string,
logged by Fastify, leakable via referrer if anything ever proxies through
HTTP) and POSTs `/mcp/messages?sessionId=...`. The auth hook accepts B's
bearer (it's valid). The handler then dispatches the message through A's
captured tenant context.

**Fix**: Verify on POST that the request's `req.tenantId` matches the
captured `session.tenantId`:

```ts
if (session.tenantId !== req.tenantId) {
  return reply.code(403).send({ error: "session/tenant mismatch" });
}
```

(This is a security finding too — flagged here because it's a structural
flaw in how the SSE transport conflates "session identity" with "request
identity".)

### H8. No CSRF protection on cookie-less but session-bearer mutations from same-origin SPA

**Severity**: High
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:204-205`

The dashboard uses `Bearer` headers from `sessionStorage` (admin-ui/src/lib/
api.ts:14-17), so traditional cookie-CSRF is not directly exploitable.
**However**: CORS is configured `origin: true` (line 205), which echoes the
request's Origin into `Access-Control-Allow-Origin` and sets `Allow-Credentials`
implicitly. Combined with the lack of any Origin / Sec-Fetch-Site validation
on mutation endpoints, an attacker page that successfully exfiltrates a
session token from sessionStorage (e.g. via a Swagger UI XSS — note that
Swagger UI is mounted under the same origin and given `'unsafe-inline'`
style-src on line 228) can use it from any context.

The Swagger UI relaxed CSP (line 225-232) allows inline styles. If any of
Swagger's runtime style nodes are influenced by user-controlled input
(they shouldn't be, but Swagger's history is full of these), an XSS in
Swagger UI on the same origin gives access to dashboard sessionStorage.

**Fix**:
1. Tighten CORS: `origin: false` or an explicit allowlist for production;
   `true` is fine for dev only.
2. Add a `Sec-Fetch-Site` check on mutation endpoints, or require a custom
   header that forms can't set without preflight.
3. Move the Swagger UI to `/api-docs/*` under a stricter CSP, or onto a
   different origin for production.

(Defer detailed CSP/CSRF discussion to the security pass.)

---

## Medium

### M1. The auth hook conflates four request taxonomies in one function

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:267-350`

The hook handles, in order: public assets (4 prefixes), dashboard SPA, login/
status/rotate, session bearer probe, /v1/auth/me-style routes, /v1/admin/*,
data-plane in three sub-modes (none/bearer/tenant). At 84 lines it's
boundary-stretching cyclomatic-complexity territory and the only test that
covers each branch is end-to-end through HTTP.

**Fix**: Pull each branch into a named predicate + handler:

```ts
const PUBLIC_PREFIXES = ["/health", "/favicon.ico", "/openapi.json", "/api-docs", "/admin"];
const PUBLIC_AUTH_ROUTES = ["/v1/auth/login", "/v1/auth/status", "/v1/auth/rotate-token"];

function isPublicRoute(url: string): boolean { /* ... */ }
function classifyRoute(url: string): "public" | "session" | "admin" | "data-plane" { /* ... */ }
async function resolveTenant(req, opts): Promise<string | null> { /* ... */ }
```

Each gets its own unit test. Done well, this is also the foundation for H1's
modularization.

### M2. Per-tenant counter map grows unboundedly in `MetricsCollector`

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/admin/metrics.ts:139,159-166`

```ts
private readonly perTenant = new Map<string, TenantSlot>();
private slot(tenantId: string): TenantSlot {
  let s = this.perTenant.get(tenantId);
  if (!s) { s = newTenantSlot(); this.perTenant.set(tenantId, s); }
  return s;
}
```

There's no eviction. A long-running service that has ever observed N
tenants holds N TenantSlot objects forever — including the ring buffers,
which themselves grow unboundedly between evictions if the per-second
QPS for a tenant exceeds the rate-window count. The `evict()` method
(line 97-102) only runs when `record()` or `count()` is called; an idle
tenant whose ring still has events in it from 5 minutes ago will keep them
until the next `record()` or `count()` triggers — fine for memory, but
worth knowing.

The bigger concern: when tenants are deleted via `engine.deleteTenant`,
their metrics slot is not removed. Counter values persist for a tenant
that no longer exists. This isn't currently exposed externally (there's
no per-tenant API listing of all known slots), but anyone iterating the
map for a future "list all tenants by activity" will see ghosts.

**Fix**: Hook tenant deletion to drop the slot:

```ts
// in MetricsCollector
removeTenant(tenantId: string): void {
  this.perTenant.delete(tenantId);
}
// and call from engine.deleteTenant after warm.deleteTenant
```

### M3. `createTenant` returns the existing tenant on conflict — that's a 200, not a 201

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:796-802`,
`/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:199-210`

`createTenant` is `INSERT … ON CONFLICT DO NOTHING` and returns the row.
The HTTP layer always responds 201. So calling `POST /v1/admin/tenants` with
an existing id gives back 201 with the original tenant's data. That's a
silent idempotent-create that doesn't match REST conventions and disagrees
with the dashboard CRUD UX (which would expect a 409 to surface "already
exists"). Compare with `POST /v1/admin/users` (line 587) and `POST
/v1/me/projects` (line 727) — both *do* check for conflicts and return 409.

**Fix**: Make tenant creation 409-on-conflict like user/project:

```ts
const existing = await opts.warm.getTenant(body.id);
if (existing) return reply.code(409).send({ error: "tenant id already exists" });
```

…or document the idempotency clearly in the OpenAPI spec.

### M4. DDL ordering in `WarmStore.initialize` is fragile — ALTER before CREATE

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/warm-store/index.ts:52-191`

The DDL list contains `ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS
project_id text` (line 108) and `ALTER TABLE memory_relations ADD COLUMN
IF NOT EXISTS project_id text` (line 110), and `ALTER TABLE memory_fts ADD
COLUMN IF NOT EXISTS project_id text` (line 112) — **before** the
`CREATE TABLE IF NOT EXISTS memory_entries` (line 117) / `memory_fts`
(line 155) / `memory_relations` (line 142) statements that they're
modifying.

On a fresh install, the ALTERs run before the CREATEs, hit
"relation does not exist", and crash the boot. Live install observation:
this only works because Postgres processes the list sequentially and
either:
  - The CREATE TABLE runs first on second boot (idempotent), or
  - Something else creates the tables before the alters (it doesn't).

Actually re-reading: on first-ever boot, line 108 `ALTER TABLE memory_entries
ADD COLUMN IF NOT EXISTS project_id` runs against a non-existent
`memory_entries`. This throws (`IF NOT EXISTS` covers the column, not the
table). The boot fails.

**Fix**: Move every `ALTER TABLE` to *after* its corresponding
`CREATE TABLE IF NOT EXISTS`. Better: drop the in-line idempotent DDL
in favour of `drizzle-kit` migrations as the comment on line 47 already
acknowledges is the right answer for v1.

### M5. `bootstrapAdmin` does not enforce password strength on the seeded admin

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/auth.ts:37-59`

The dashboard `POST /v1/admin/users` enforces `min(8)` via
`CreateUserBody.password`. The bootstrap path takes whatever is in the env
var and bcrypts it directly. An operator setting `NOVAMEM_BOOTSTRAP_ADMIN_
PASSWORD=admin` is silently accepted and immediately becomes the only
admin login.

**Fix**: Add the same minimum-length check (or stronger — bootstrap admins
should arguably require ≥16 chars), with a hard error and an actionable
message at boot if violated.

### M6. The same admin is mintable twice if the env var is rotated mid-run

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/auth.ts:43-44`

`bootstrapAdmin` checks `existing > 0` — i.e. *any* admin exists, not
specifically the bootstrap one. So if the operator deletes their bootstrap
admin via the dashboard, restarts with a different env var, the new admin
is **not** seeded (because the dashboard might have other admins). Likely
intentional. But the message at line 46-50 is misleading in that case:
it tells the operator to set the env vars, but those env vars *are* set —
the gate is "no admins exist", not "env vars unset". Easy to fix the wording.

### M7. `engine.search` mutates the result loop counter named `graphHits` twice

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:183,241`

```ts
let graphHits: Array<{ id: string; score: number }> = [];   // line 183
// ...
let graphHits = 0;                                          // line 241 — same name, inner block
```

Inside the metrics block (`for (const f of results)`), `graphHits` is
reused as a counter. The outer `graphHits` is the array of graph search
hits from FalkorDB. The inner block is in a `let` shadow scope, but the
naming is genuinely confusing — and one is iterated, one is summed; one is
typed as `Array<{...}>`, the other as `number`. Pure readability issue
that nearly tricked me into thinking there was a bug.

**Fix**: Rename the inner counters: `warmCount`, `coldCount`, `graphCount`.

### M8. `forget` SQL is not transactional — partial state on mid-delete crash

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:386-396`

```ts
await pool.query("DELETE FROM memory_fts WHERE entry_id = $1 AND tenant_id = $2", [id, tenantId]);
await pool.query("DELETE FROM memory_access WHERE entry_id = $1", [id]);
await pool.query("DELETE FROM memory_relations WHERE (from_id = $1 OR to_id = $1) AND tenant_id = $2", ...);
await pool.query("DELETE FROM memory_entries WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
```

Four sequential DELETE statements without a `BEGIN`/`COMMIT`. If the
process crashes between FTS-delete and entries-delete, the FTS row is gone
but the entry remains, and subsequent searches won't return the entry —
but `recent()` will (it queries `memory_entries` directly). This kind of
partial state is uncommon but pernicious to debug.

`WarmStore.deleteTenant` (line 366-395) **does** wrap its deletes in
`BEGIN`/`COMMIT`. Same pattern should apply here.

**Fix**: Move the four DELETEs into a `WarmStore.forgetEntry(tenantId,
id)` method that uses `pool.connect()` + transaction, mirroring
`deleteTenant`.

### M9. Plaintext bearer token logged in MCP-SSE handshake

**Severity**: Medium
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:938`

```ts
req.log.info({ sessionId, tenantId }, "mcp-sse: session opened");
```

That's fine — but `tenantId` is sometimes-derived from the bearer, which
itself was not logged but was parsed from the header at line 300. Confirm
that Fastify's logger configuration redacts `req.headers.authorization`
by default. If not, every request header is logged at `info` — that's a
plaintext bearer in your log file. Pino's default config does *not* redact
headers; you need `redact: ["req.headers.authorization"]` in the logger
options.

**Fix**: In `Fastify({ logger: { level: ..., redact: [...] } })` (line 204):

```ts
logger: {
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true },
}
```

---

## Low

### L1. Hand-written 716-line `openapi.ts` will drift from Zod schemas

**Severity**: Low
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/openapi.ts`

The file's own header (lines 5-8) acknowledges this: "We don't auto-generate
from Zod schemas (would need fastify-type-provider-zod and a wholesale
route refactor)." It's a long, hand-maintained mirror of every Zod schema
in `http.ts`. Today it's accurate; in three months when someone adds
`/v1/foo` and forgets to update openapi.ts, it won't be. There is no test
that asserts equivalence.

**Fix (deferred)**: Adopt `fastify-type-provider-zod` or `zod-to-openapi`
when the route count next grows. For now, add a unit test that asserts
*every Zod schema name has a matching components.schemas entry* — won't
catch field-level drift but catches whole-route drift.

### L2. React pages share a heavy "load + busy + toast + error" pattern that is repeated five times

**Severity**: Low
**Files**:
- `/Users/pascal/Development/novamem-1/packages/admin-ui/src/pages/TenantsPage.tsx:23-44`
- `/Users/pascal/Development/novamem-1/packages/admin-ui/src/pages/UsersPage.tsx:21-39`
- `/Users/pascal/Development/novamem-1/packages/admin-ui/src/pages/MyTokensPage.tsx:13-50`
- `/Users/pascal/Development/novamem-1/packages/admin-ui/src/pages/ProjectsPage.tsx:24-50`
- `/Users/pascal/Development/novamem-1/packages/admin-ui/src/pages/MetricsPage.tsx`

Each page re-implements: useState for data + busy, useCallback for refresh,
useEffect to trigger it, and the "if r.body set state" pattern. Combined
~150 lines of effectively-identical scaffolding.

**Fix**: A `useApiResource` hook:

```ts
function useApiResource<T>(method, path) {
  const [data, setData] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    const r = await api<T>(method, path);
    setBusy(false);
    if (r.body) setData(r.body);
    return r;
  }, [method, path]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, busy, refresh };
}
```

…or adopt SWR / React Query for an industry-standard solution that also
gives caching, retry, and revalidation. Worth doing if this dashboard is
going to grow; not urgent.

### L3. `engine.maybePromote` mutates `promotedSinceLastDecay` from many concurrent search calls without synchronization

**Severity**: Low
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:58,84`

JavaScript is single-threaded so this is currently safe — but the field is
also reset to 0 *between* `INSERT INTO decay_runs` and the
`UPDATE decay_runs ... promoted = $2` (line 277-279). Any promotions that
happen during the decay loop's body get attributed to the *next* decay run,
not the current one. Trivial mis-attribution but worth a comment.

### L4. `effectiveDays` math duplicated between engine and decay loop

**Severity**: Low
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/engine/index.ts:81,269`

Line 81 (promotion path):
```ts
const lifespan = effectiveDays(preBump.hits + 1);
```

Line 269 (decay path):
```ts
const lifespan = (effectiveDays(c.hits) / 7) * baseDays;
```

Same concept, two different formulas. The promotion path uses raw
`effectiveDays(hits+1)` (which is `7 * log2(hits+2)`), the decay path
*scales* `effectiveDays(hits)` by `baseDays/7`. So the override
`effectiveDaysOverride` shifts decay-side decisions but not promotion-side
decisions. If an operator sets `effectiveDays=14` they get *less*
aggressive demotion AND *unchanged* promotion thresholds — the asymmetry
is probably not intentional. At minimum needs a docstring.

### L5. Many `(req.params as { id: string }).id` casts in http.ts — type-unsafe

**Severity**: Low
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:607,630,703,740,753,762,779,813,828,846,859`

Eleven places do `(req.params as { id: string }).id` or similar. Fastify
supports a request schema typing flow (Zod or json-schema), or a shared
helper:

```ts
function paramId(req): string {
  return (req.params as { id: string }).id;
}
```

Or move to schemas:

```ts
app.delete<{ Params: { id: string } }>("/v1/admin/tenants/:id", ...)
```

Boring tech-debt, but cleans up a dozen lines.

### L6. CORS `origin: true` is incompatible with documented "session bearer in sessionStorage" model

**Severity**: Low
**File**: `/Users/pascal/Development/novamem-1/packages/server/src/http.ts:205`

For an SPA-on-same-origin model the CORS is unnecessary, and for any
cross-origin caller it's overly permissive. Either tighten to a configured
origin list (production) or drop CORS entirely if the dashboard is the only
intended browser client. (Largely the same point as H8; flagging here as
the configuration hygiene is independent of the CSRF concern.)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2     |
| High     | 8     |
| Medium   | 9     |
| Low      | 6     |
| **Total**| **25**|

Top 3 to fix first (highest leverage / lowest risk):

1. **C1 + M9 (logging + session GC)** — both are 1-line config additions that
   close real exposure and cost nothing.
2. **H3 + H4 (Scope value-object)** — single refactor that cleans up four
   stores, makes the fakes meaningfully simpler, and lets H5 (test fakes)
   shrink dramatically. Pays for itself on the next isolation feature.
3. **H1 + M1 (split http.ts)** — needed before the file grows past 1000 LOC.
   Auth-hook is a security-critical 84 lines that deserves its own module
   and unit tests.

C2 (project-scoped token survives membership revocation) is a security
finding masquerading as a code-quality one — it should be re-examined
in the security pass.
