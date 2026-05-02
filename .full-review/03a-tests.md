# Phase 3a — Testing Review

Repository: novamem (monorepo, 4 packages).
Server tests: 138 passing across 7 test files (`http.test.ts`, `engine.test.ts`, `mcp.test.ts`, `admin/metrics.test.ts`, `engine/hybrid-search.test.ts`, `config.test.ts`, `embeddings.test.ts`) plus an env-flag-gated `tests/integration.test.ts`.
Other packages: **zero** tests (`packages/admin-ui` has `"test": "echo 'no tests' && exit 0"`; `packages/client` and `packages/mcp` use `vitest run --passWithNoTests`).

Verdict: server-side data plane and HTTP routes are well covered (good tenant-isolation regression tests in `engine.test.ts`, good RBAC + admin lifecycle coverage in `http.test.ts`). The big gaps are (1) the Phase 2 critical security findings have no regression tests, (2) the React dashboard and `@azrty/novamem` client have no automated coverage at all, and (3) the test fakes' SQL substring parsing is fragile.

---

## T-C1 — [Critical] No regression test for kicked-member tokens (S-C2)

**File:** `packages/server/src/http.test.ts` (would belong here, missing).

`removeProjectMember` only deletes the membership row; the kicked user's project-scoped tokens still authorise reads/writes (Phase 2 S-C2). Today's only project-member test (`http.test.ts:1078`) walks the *happy* add+share path. There is no test asserting that after a member is removed their previously-minted project token stops working.

**Recommendation** — add to the "projects (sub-brains)" describe:

```ts
it("removed member's project token stops working", async () => {
  const { app, session } = await setupBobInAcme();
  const authBob = { authorization: `Bearer ${session}` };
  await app.inject({ method: "POST", url: "/v1/me/projects",
    payload: { id: "shared", name: "Shared" }, headers: authBob });
  await app.inject({ method: "POST", url: "/v1/me/projects/shared/members",
    payload: { username: "carol" }, headers: authBob });

  const carolLogin = await app.inject({ method: "POST", url: "/v1/auth/login",
    payload: { username: "carol", password: "carolpass1" }});
  const authCarol = { authorization: `Bearer ${carolLogin.json().token}` };
  const carolTok = (await app.inject({ method: "POST", url: "/v1/me/tokens",
    payload: { projectId: "shared" }, headers: authCarol })).json().token;

  // Sanity — works.
  const ok = await app.inject({ method: "POST", url: "/v1/recent", payload: {},
    headers: { authorization: `Bearer ${carolTok}` }});
  expect(ok.statusCode).toBe(200);

  // Bob removes Carol.
  const carolUserId = (await app.inject({ method: "GET", url: "/v1/me/projects/shared/members", headers: authBob })).json().members.find((m: any) => m.username === "carol").userId;
  await app.inject({ method: "DELETE", url: `/v1/me/projects/shared/members/${carolUserId}`, headers: authBob });

  // Carol's token must now 401.
  const after = await app.inject({ method: "POST", url: "/v1/recent", payload: {},
    headers: { authorization: `Bearer ${carolTok}` }});
  expect(after.statusCode).toBe(401);
});
```

This will fail today (S-C2 still open). It locks in the contract for the eventual fix (membership recheck OR token revocation on member-remove).

---

## T-C2 — [Critical] No regression test for cross-tenant project-member forget (S-H2)

**File:** `packages/server/src/engine/engine.test.ts`.

`engine.forget` always passes the bearer's `tenantId` to the warm-store DELETE. A cross-tenant project member's forget on a shared-project entry silently no-ops while the function returns `{ deleted: true }` (Phase 2 S-H2). Existing tenant-isolation tests (lines 359–414) cover *negative* cross-tenant forget — they pass deliberately because no shared project exists. The shared-project case is unrepresented.

**Recommendation** — extend `FakeWarmStore.pool.query`'s `DELETE FROM memory_entries` branch to honour `project_id = $N` when the SQL contains it, then:

```ts
it("cross-tenant project member can forget a shared-project entry", async () => {
  const b = bench();
  // Bob's tenant remembers in shared project.
  const { id } = await b.engine.remember("acme", { content: "shared note" }, { projectId: "shared" });
  // Carol (different tenant) is a member of "shared" — she invokes forget
  // through the project-scoped path.
  const r = await b.engine.forget("contoso", id, { projectId: "shared" });
  expect(r.deleted).toBe(true);
  expect(b.warm.rows.has(id)).toBe(false);
});
```

Today this either fails or silently passes against a fake that doesn't model the bug — fixing the fake first (so it filters the same way production SQL does) is the load-bearing step.

---

## T-C3 — [Critical] No test for `getEntry` `projectId === "*"` bypass (S-C4)

**File:** `packages/server/src/warm-store/` (no warm-store unit test exists).

`warm-store/index.ts:847-864` exposes a magic-string bypass that disables tenant + project scope checks. There is no warm-store unit test today and no regression that asserts the bypass is actually unreachable from any caller. Once the fix lands (replace with typed `bypassScope?: true`), a regression test is essential.

**Recommendation** — add `packages/server/src/warm-store/warm-store.test.ts` running against the fake DDL the integration suite already sets up, OR a tighter unit test using the `pg` mock:

```ts
it("getEntry refuses projectId='*' (no magic-string bypass)", async () => {
  const ws = await openTestWarmStore(); // helper using PGlite or testcontainers
  await ws.insertEntry({ id: "01F", tenantId: "acme", projectId: "phoenix", ... });
  await expect(ws.getEntry("contoso", "01F", { projectId: "*" }))
    .rejects.toThrow(/projectId/);
});
```

If a typed `bypassScope: true` API replaces the magic, the symmetric positive test belongs in admin-only paths.

---

## T-C4 — [High] No test for tenant id `p_*` prefix collision (S-C1)

**File:** would belong in `packages/server/src/cold-store.test.ts` (does not exist) **or** the existing tenant-create route test in `http.test.ts:371`.

The existing test (`rejects invalid tenant ids at creation`) asserts spaces/exclamation are rejected, but `p_anything` passes today's regex and triggers Phase 2 S-C1 (cold-store prefix scan wipes shared-project vector data on tenant delete). A trivial regression test:

```ts
it.each(["p", "p_evil", "P_evil"])("rejects tenant id %s (collides with project prefix)", async (id) => {
  const { app } = makeApp({ authMode: "tenant", adminToken: "admin-secret" });
  const r = await app.inject({ method: "POST", url: "/v1/admin/tenants",
    payload: { id, name: id }, headers: { authorization: "Bearer admin-secret" }});
  expect(r.statusCode).toBe(400);
});
```

Plus a destructive-side test in the (future) `cold-store.test.ts`:

```ts
it("deleteAllForTenant('p') does NOT wipe project-scoped collections", async () => {
  // Seed novamem_p_proj1_default and novamem_p_other; ensure both survive.
});
```

---

## T-H1 — [High] Zero coverage on the React dashboard

**Files:** `packages/admin-ui/**` — no Vitest config, no React Testing Library, no Playwright, `package.json` literally `"test": "echo 'no tests' && exit 0"`.

Critical pages with no automated check: `SignIn.tsx` (auth flow + sessionStorage write), `MyTokensPage.tsx` (one-time-show pattern, copy + revoke), `ProjectsPage.tsx` (member CRUD modals — the most behaviour-heavy page), `TenantsPage.tsx`, `UsersPage.tsx`, plus the `Modal`/`Toast` primitives. Phase 2 S-H4 noted post-XSS session theft via `sessionStorage` — there is no test asserting tokens never appear in DOM/console after copy.

**Recommendation — minimum viable bar**:

1. Add Vitest + JSDOM + React Testing Library to `admin-ui`:
   ```json
   { "test": "vitest run", "scripts": { "test:ui": "vitest" } }
   ```
2. Mock `lib/api.ts` with MSW; write component tests for the highest-value flows. Example:

```tsx
// packages/admin-ui/src/pages/SignIn.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import SignIn from "./SignIn";

describe("SignIn", () => {
  it("posts credentials and stashes the token", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "ns_test", user: { username: "alice", role: "admin" }}),
        { status: 201, headers: { "content-type": "application/json" }}));
    render(<SignIn />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice" }});
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "supersecret" }});
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(sessionStorage.getItem("novamem.session")).toBe("ns_test"));
    fetchSpy.mockRestore();
  });

  it("shows error on 401 without storing token", async () => { /* ... */ });
});
```

3. Add Playwright for the few cross-page smoke flows that matter (login → mint token → see it in Tokens page → revoke → 401 on a protected fetch). One file, ~5 tests, catches 80% of the currently-uncaught regressions.

---

## T-H2 — [High] Zero coverage on `@azrty/novamem` client

**Files:** `packages/client/src/index.ts` (~13kB) — only `vitest run --passWithNoTests`.

The client now wraps the data plane + auth + projects + tokens. Method signatures and return shapes are user-facing API. A typo in `client.createProject` would not be caught by CI. Subprocess/TTY mocking for `novamem-login` is genuinely hard, but `NovamemClient` is just `fetch` + JSON.

**Recommendation** — `packages/client/src/index.test.ts` with MSW or an inline `vi.spyOn(global, "fetch")`:

```ts
import { describe, it, expect, vi } from "vitest";
import { NovamemClient } from "./index.js";

describe("NovamemClient", () => {
  it("login posts credentials and returns the token", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "ns_x", user: { username: "alice" }}),
        { status: 201 }));
    const c = new NovamemClient({ baseUrl: "http://x" });
    const r = await c.login("alice", "pw");
    expect(r.token).toBe("ns_x");
    expect(fetchSpy).toHaveBeenCalledWith("http://x/v1/auth/login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "pw" }),
    }));
  });

  it("propagates non-2xx as typed error with status", async () => { /* ... */ });
  it("createProject + listProjects round-trip", async () => { /* ... */ });
  it("mintToken passes projectId when provided", async () => { /* ... */ });
});
```

15 tests gets to meaningful coverage.

---

## T-H3 — [High] Test fakes parse production SQL via substring match (Phase 1 H5)

**File:** `packages/server/src/test-fakes.ts` (822 LOC).

`FakeWarmStore.pool.query` matches on `sql.includes("FROM memory_entries")`, `sql.includes("project_id = $")`, etc. (lines 50–108 are representative). When production SQL is refactored — even a comment change — the fake silently mismatches, the test passes against the *fake's* notion of the query, and the bug ships. Two of the Phase 2 criticals (S-H2 cross-tenant forget, S-C4 magic `*`) survive partly because the fake doesn't model the bug honestly.

**Recommendation** — replace with one of:

1. **PGlite** (`@electric-sql/pglite`) — embedded Postgres in WASM, ~5MB, runs in vitest. Use the real warm-store DDL + queries; tests become integration-grade with no docker.

   ```ts
   import { PGlite } from "@electric-sql/pglite";
   import { WarmStore } from "./warm-store/index.js";
   const pg = new PGlite();
   const ws = new WarmStore({ pool: pg as any });
   await ws.initialize();
   ```

2. **Testcontainers** for the integration suite (already exists), retire the SQL-substring fake from unit tests, keep a thin in-memory `Map<id, row>` fake **only** for the engine unit tests where SQL surface isn't relevant. The engine tests don't need the SQL parser at all — they should call typed `WarmStore` methods.

   That's the bigger refactor: split `FakeWarmStore` into `InMemoryWarmStore` (typed, no SQL) for engine tests + drop the `pool.query` shim entirely. The engine doesn't issue raw SQL today — `engine/index.ts` uses warm-store methods, so the `pool.query` branch is only there because two old code paths leak through.

---

## T-H4 — [High] No tests for bcrypt password edge cases

**File:** `packages/server/src/auth.ts` (no `auth.test.ts`).

`hashPassword`/`verifyPassword` are tested only transitively via the http login flow. Untested: empty password, password longer than bcrypt's 72-byte truncation point (silent wrap-around bug class), unicode passwords with multi-byte chars, password change paths (does old hash stop verifying?), bootstrapAdmin idempotency (Phase 2 S-H6 noted no complexity floor).

**Recommendation** — `packages/server/src/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, bootstrapAdmin } from "./auth.js";
import { FakeWarmStore } from "./test-fakes.js";

describe("auth: bcrypt boundaries", () => {
  it("rejects empty password at hash time", async () => {
    await expect(hashPassword("")).rejects.toThrow(/empty|length/);
  });
  it("verify is constant-ish-time wrt hash structure", async () => {
    const h = await hashPassword("supersecret");
    expect(await verifyPassword("supersecret", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("supersecret", "$2b$10$invalid")).toBe(false); // doesn't throw
  });
  it("≥73-byte passwords behave deterministically (document bcrypt truncation)", async () => {
    const long = "x".repeat(80);
    const h = await hashPassword(long);
    expect(await verifyPassword(long, h)).toBe(true);
    // Document the truncation behaviour or pre-hash with sha256 to avoid it.
    expect(await verifyPassword("x".repeat(72), h)).toBe(true); // ← would surface the bug
  });
});

describe("bootstrapAdmin", () => {
  it("is idempotent — second call doesn't double-create the admin", async () => {
    const warm = new FakeWarmStore();
    await bootstrapAdmin(warm as any, { username: "alice", password: "supersecret" });
    await bootstrapAdmin(warm as any, { username: "alice", password: "supersecret" });
    const users = [...warm.users.values()].filter((u) => u.username === "alice");
    expect(users.length).toBe(1);
  });
});
```

The 73-byte case in particular is the kind of latent bug nobody finds until production.

---

## T-H5 — [High] No tests for last-admin / self-delete semantics beyond the happy path

**File:** `packages/server/src/http.test.ts:831` (`refuses to delete self or the last admin`).

Existing test only covers self-delete. There is no separate "delete the only other admin" or "demote the last admin" path. The check at fault when last-admin protection is wrong is on demote-via-role-change, not delete.

**Recommendation** — extend the describe:

```ts
it("refuses to demote the last remaining admin", async () => {
  const { app, adminPwd } = await setupWithAdmin();
  const login = await app.inject({ method: "POST", url: "/v1/auth/login",
    payload: { username: "alice", password: adminPwd }});
  const auth = { authorization: `Bearer ${login.json().token}` };
  const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: auth });
  const r = await app.inject({ method: "POST", url: `/v1/admin/users/${me.json().user.id}/role`,
    payload: { role: "user", tenantId: "acme" }, headers: auth });
  expect(r.statusCode).toBe(400);
});

it("allows demoting an admin when at least one other admin remains", async () => { /* ... */ });
it("refuses to delete the last admin when self-delete check is bypassed by deleting another admin", async () => { /* ... */ });
```

---

## T-H6 — [High] SSE-MCP session bind has no bearer-rebind test (S-H1)

**File:** `packages/server/src/http.test.ts:208` covers only "no sessionId → 400" and "unknown sessionId → 404".

Phase 2 S-H1: `/mcp/messages` only checks `sessionId`; a *different* bearer that learns a sessionId (via logs — sessionId is logged at `http.ts:938`) can post to it. No regression test.

**Recommendation**:

```ts
it("POST /mcp/messages rejects when bearer differs from the SSE bearer", async () => {
  const { app, tokenA, tokenB } = await setupTenantApp();
  // Open SSE as A, capture sessionId (the test transport doesn't expose it
  // directly — implement a getActiveSessions() spy on the SSE manager for tests).
  const sessionId = await openSseAndCaptureSession(app, tokenA);
  // B posts to A's session — must 401/403, not 200.
  const r = await app.inject({
    method: "POST", url: `/mcp/messages?sessionId=${sessionId}`,
    payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect([401, 403]).toContain(r.statusCode);
});
```

This test will fail until S-H1 is fixed; that's the point.

---

## T-H7 — [High] No test for admin-token-equivalent-to-admin-session reachability of `/v1/admin/*`

**File:** `packages/server/src/http.test.ts`.

The codebase supports two ways to reach `/v1/admin/*`: legacy `NOVAMEM_ADMIN_TOKEN` and an admin-role session. Tests cover each in isolation. Nothing asserts both reach all the same routes — and nothing asserts a *user-role* session gets 401 on every admin route (line 918 only tests `/v1/admin/users`).

**Recommendation** — table-driven:

```ts
const ADMIN_ROUTES: Array<[string, string]> = [
  ["GET", "/v1/admin/users"], ["GET", "/v1/admin/tenants"],
  ["GET", "/v1/admin/metrics"], ["POST", "/v1/admin/users"],
  // ...etc, every admin route from openapi.ts
];

it.each(ADMIN_ROUTES)("user-role session is denied on %s %s", async (method, url) => {
  const { app, /* user session */ } = await setupBobInAcme();
  const r = await app.inject({ method, url, payload: {}, headers: { authorization: `Bearer ${session}` }});
  expect(r.statusCode).toBe(401);
});

it.each(ADMIN_ROUTES)("legacy admin token reaches %s %s", async (method, url) => { /* ... */ });
it.each(ADMIN_ROUTES)("admin-role session reaches %s %s", async (method, url) => { /* ... */ });
```

Catches all future "I added a route and forgot the auth hook" regressions in one place.

---

## T-H8 — [High] No login-throttle / brute-force test (S-C3)

**File:** `packages/server/src/http.test.ts`.

The throttle isn't implemented yet (Phase 2 S-C3), but the test belongs alongside the fix and should be written first to drive it.

**Recommendation** — TDD spec:

```ts
it("login throttle: 6th attempt within window is rejected with 429", async () => {
  const { app } = await setupWithAdmin();
  for (let i = 0; i < 5; i++) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login",
      payload: { username: "alice", password: "wrong" }});
    expect(r.statusCode).toBe(401);
  }
  const r6 = await app.inject({ method: "POST", url: "/v1/auth/login",
    payload: { username: "alice", password: "wrong" }});
  expect(r6.statusCode).toBe(429);
  // Even with the correct password, still throttled.
  const r7 = await app.inject({ method: "POST", url: "/v1/auth/login",
    payload: { username: "alice", password: "supersecret" }});
  expect(r7.statusCode).toBe(429);
});

it("throttle is per-username, not per-IP", async () => {
  // Five wrong attempts on alice don't lock bob out.
});
```

Drives the implementation toward the right shape.

---

## T-H9 — [High] No tests for audit log — feature missing (S-H9)

**File:** would belong in `packages/server/src/audit.test.ts` once the feature exists.

Phase 2 S-H9: no audit logging of admin actions. Once the feature lands, regressions are easy. A specification test now ensures it ships testable.

**Recommendation** — write the spec ahead of implementation:

```ts
describe("audit log", () => {
  it("records tenant-create with actor, action, target, ts", async () => {
    const { app, audit } = makeApp({ authMode: "tenant", adminToken: "admin-secret", withAudit: true });
    await app.inject({ method: "POST", url: "/v1/admin/tenants",
      payload: { id: "acme", name: "Acme" }, headers: { authorization: "Bearer admin-secret" }});
    expect(audit.entries).toContainEqual(expect.objectContaining({
      action: "tenant.create", actor: "legacy-admin", target: "acme",
    }));
  });
  it("records user.role.change with both old and new role", async () => { /* ... */ });
  it("records token.mint and token.revoke (token plaintext NOT stored)", async () => { /* ... */ });
});
```

---

## T-M1 — [Medium] No tests for DDL idempotency / re-init order

**Files:** `packages/server/src/warm-store/index.ts:initialize`, no warm-store unit test.

Phase 1 surfaced an M4/A9 ordering bug in DDL. The integration suite restarts only against a clean DB. No test asserts initialize-twice-on-existing-DB is a no-op (the `pg_advisory_xact_lock` recommendation in P-H7 implies multi-replica boots).

**Recommendation** — PGlite-backed test:

```ts
it("WarmStore.initialize is idempotent", async () => {
  const pg = new PGlite();
  const ws = new WarmStore({ pool: pg as any });
  await ws.initialize();
  await ws.initialize();   // must not throw
  await ws.initialize();   // and again
});
it("two concurrent initialize() do not race the same CREATE", async () => {
  const pg = new PGlite();
  const ws = new WarmStore({ pool: pg as any });
  await Promise.all([ws.initialize(), ws.initialize()]);
});
```

---

## T-M2 — [Medium] Decay perf regression test (P-C1)

**File:** would be `packages/server/src/engine/engine.perf.test.ts`.

P-C1: decay does N round-trips per cold candidate. No test asserts this scales. Even a small bench bound (e.g. 10k entries should complete in <2s) would catch a regression to a quadratic implementation.

**Recommendation**:

```ts
it("decay: 10k stale entries demoted in <2s and ≤K queries", async () => {
  const b = bench();
  const N = 10_000;
  for (let i = 0; i < N; i++) {
    const { id } = await b.engine.remember("public", { content: `e${i}` });
    b.warm.rows.get(id)!.lastAccessed = new Date(Date.now() - 30 * 86400_000);
  }
  const queriesBefore = b.warm.queryCount; // add a counter to the fake
  const t0 = performance.now();
  const r = await b.engine.decay();
  const elapsed = performance.now() - t0;
  expect(r.demoted).toBe(N);
  expect(elapsed).toBeLessThan(2000);
  expect(b.warm.queryCount - queriesBefore).toBeLessThan(50); // one bulk UPDATE, not N
});
```

The "≤50 queries" assertion is the load-bearing one — it forces the bulk-SQL refactor.

---

## T-M3 — [Medium] Property tests for pure-logic functions

**Files:** `engine/index.ts` — `effectiveDays(hits)`, `fuse(...)` and `MetricsCollector.recordQuery`.

These are stateless transformations, easy to property-test, and they govern correctness in non-obvious ways (decay decisions, search ranking). Today's tests exercise a handful of points; a fuzzed property test catches off-by-one and overflow.

**Recommendation** — `fast-check`:

```ts
import fc from "fast-check";

it("effectiveDays is monotonic non-decreasing in hits", () => {
  fc.assert(fc.property(fc.nat(10_000), fc.nat(10_000), (a, b) => {
    if (a > b) return effectiveDays(a) >= effectiveDays(b);
    return effectiveDays(b) >= effectiveDays(a);
  }));
});

it("fuse: weights summing to zero yield zero score for any signals", () => {
  fc.assert(fc.property(
    fc.float({ min: 0, max: 1 }), fc.float({ min: 0, max: 1 }), fc.float({ min: 0, max: 1 }),
    (k, v, g) => fuse({ keyword: k, vector: v, graph: g }, { keyword: 0, vector: 0, graph: 0 }) === 0,
  ));
});

it("MetricsCollector counters are monotonic non-decreasing", () => {
  // After any sequence of recordX events, snapshot.counters[*] >= previous snapshot.
});
```

---

## T-M4 — [Medium] `setupBobInAcme` and `setupWithAdmin` are duplicated

**File:** `packages/server/src/http.test.ts` (`setupBobInAcme` defined at 940; near-duplicate logic in `setupWithAdmin` at 727 and `bootstrap` at 546).

Each is re-defined per `describe`. Convergence drift is likely; one already has subtle differences (which tenants are seeded). A shared `test-fixtures.ts` reduces churn.

**Recommendation** — extract to `packages/server/src/test-fixtures.ts`:

```ts
export async function withTenantApp(opts: { admins?: string[]; users?: Array<{...}>; projects?: ... } = {}) { ... }
export async function withBobInAcme(): Promise<{ app; warm; bobSession; carolSession }> { ... }
```

Doesn't change coverage but reduces the cost of adding tests, which is the underlying bottleneck for closing every other gap on this list.

---

## T-M5 — [Medium] No coverage report configured

**File:** `packages/server/vitest.config.ts` (and root if any).

`vitest run` runs without coverage. CI doesn't track which lines are tested. Phase 1 H5 (fragile fakes) gets worse silently as coverage drifts.

**Recommendation**:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.ts", "src/test-fakes.ts"],
      thresholds: { lines: 75, functions: 75, branches: 65 },
    },
  },
});
```

Add a CI step `pnpm -r test --coverage` and fail the build under threshold. Today's likely coverage is high on `engine/`, low on `warm-store/`, near-zero on `auth.ts` and the React/client packages.

---

## T-M6 — [Medium] No CI hook visible

**Files:** no `.github/workflows/`, no `.gitlab-ci.yml` found in the repo root snapshot.

Tests run locally via `pnpm test`. There is no evidence they're enforced on PR. All 138 server tests can be passing while a refactor on `main` quietly regresses an untested path.

**Recommendation** — `.github/workflows/test.yml`:

```yaml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck
      - run: pnpm -r test
      - run: pnpm --filter @azrty/novamem-server test:integration
        env: { NOVAMEM_INTEGRATION: "1" }
        services:
          postgres: { image: postgres:16, ... }
          qdrant: { image: qdrant/qdrant:latest, ports: [6333] }
          falkordb: { image: falkordb/falkordb:latest, ports: [6379] }
```

Without this, every other test recommendation in this file is theatre.

---

## T-L1 — [Low] Assertion granularity is loose in HTTP tests

**File:** `packages/server/src/http.test.ts` throughout.

The dominant pattern is `expect(r.statusCode).toBe(200)` with shallow body checks. Lines 95–103 explicitly accept three different status codes for the same input (`expect([400, 413, 500]).toContain(r.statusCode)`) — that's a tolerant assertion that papers over an actual bug class (input validation should be 400, not 500). Same shape at 379 (`[400, 500]`) and 716/722 (`[200, 301, 302]`).

**Recommendation** — tighten when the behaviour is well-defined:

```ts
// Before:
expect([400, 413, 500]).toContain(r.statusCode);
// After: oversize content should be a 413 (or 400 for non-streaming bodies).
expect(r.statusCode).toBe(413);
expect(r.json().error).toMatch(/payload too large|content/i);
```

Where the behaviour genuinely is multi-valued (Swagger UI 200 vs 301 — depends on plugin version), document it inline so the next refactor knows it's deliberate.

---

## T-L2 — [Low] `engine.test.ts` uses real timer for some tests, fake for others, real for cold→warm

**File:** `packages/server/src/engine/engine.test.ts:185–217` (decay), 220–256 (cold→warm) — only decay's describe uses `vi.useFakeTimers()`. `Date.now()` in cold→warm tests means the suite is sensitive to clock skew on slow CI.

**Recommendation** — inject a `now()` clock into `MemoryEngine` (the metrics collector already accepts one) and use it everywhere instead of `Date.now()`. Then `vi.useFakeTimers()` in a top-level `beforeEach` becomes unnecessary and the suite is fully deterministic.

---

## Summary table

| Id | Severity | Area | Why it matters |
|---|---|---|---|
| T-C1 | Critical | Server (regression) | S-C2 has no test; kicked-member tokens still work |
| T-C2 | Critical | Server (regression) | S-H2 has no test; cross-tenant member's forget silently no-ops |
| T-C3 | Critical | Server (regression) | S-C4 has no test; magic-string tenant bypass survives refactors |
| T-C4 | High | Server (regression) | S-C1 has no test; tenant `p_*` deletes shared-project vectors |
| T-H1 | High | Frontend | Zero coverage on the React dashboard; XSS-adjacent paths uncaught |
| T-H2 | High | Client SDK | Zero coverage on `@azrty/novamem`; user-facing API regressions silent |
| T-H3 | High | Test infra | SQL-substring fakes hide the very bugs Phase 2 found |
| T-H4 | High | Server (auth) | Bcrypt edge cases (≥72 bytes, empty, idempotent bootstrap) untested |
| T-H5 | High | Server (RBAC) | Last-admin demote path untested; only delete-self covered |
| T-H6 | High | Server (regression) | S-H1 SSE bearer-rebind has no test |
| T-H7 | High | Server (RBAC) | No table-driven "every admin route refuses user-role" sweep |
| T-H8 | High | Server (regression) | S-C3 throttle test belongs alongside the fix |
| T-H9 | High | Server (regression) | S-H9 audit log spec drives the missing feature |
| T-M1 | Medium | Server (DDL) | initialize() idempotency / concurrent boot untested |
| T-M2 | Medium | Server (perf) | P-C1 decay scaling has no perf-bound test |
| T-M3 | Medium | Server (logic) | No property tests on `effectiveDays`/`fuse`/metrics |
| T-M4 | Medium | Test infra | Setup helpers duplicated across describes — convergence drift |
| T-M5 | Medium | Test infra | No coverage report; coverage drift invisible |
| T-M6 | Medium | Test infra | No CI workflow visible; tests are not enforced on PR |
| T-L1 | Low | Server (style) | Multi-status `expect([400,413,500]).toContain` papers over bugs |
| T-L2 | Low | Server (style) | Mixed real/fake timers — flaky on slow CI |

**Headline recommendations:**
1. Land T-C1 / T-C2 / T-C3 / T-C4 as failing tests *before* the Phase 2 fixes — they pin down the contracts.
2. Replace SQL-substring fakes with PGlite (T-H3) — unblocks honest tests for every other server item.
3. Stand up Vitest + RTL + a 5-spec Playwright suite for `admin-ui` (T-H1) and a 15-spec MSW suite for the client (T-H2). Without these, two whole packages are untested.
4. Add a GitHub Actions workflow (T-M6) and a coverage threshold (T-M5). Tests that aren't run on PR don't exist.
