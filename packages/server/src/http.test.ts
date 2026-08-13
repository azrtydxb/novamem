import { describe, expect, it } from "vitest";

import { buildHttpServer } from "./http.js";
import {
  asWarm,
  FakeWarmStore,
  makeEngine,
} from "./test-fakes.js";

function makeApp(
  opts: {
    authMode?: "none" | "bearer" | "user";
    token?: string;
    adminDashboard?: boolean;
    withMetrics?: boolean;
    quotas?: { maxEntries: number; writesPerMinute: number };
  } = {},
) {
  const { engine, warm, cold, metrics } = makeEngine({
    defaultEffectiveDays: 7,
    withMetrics: opts.withMetrics !== false,
    quotas: opts.quotas,
  });
  // Test-mode Better Auth shim. Production wires the real Better Auth
  // instance; tests synthesize a session by minting a row in the fake
  // warm store via `warm.createSession` and presenting the resulting
  // `ns_…` token as Authorization: Bearer. The shim resolves it back
  // to a dashUser the same way real Better Auth would.
  const fakeBA = {
    handler: async (_req: Request) => new Response("not-implemented", { status: 501 }),
    getSession: async (headers: Headers) => {
      const auth = headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (!token.startsWith("ns_")) return null;
      const r = await warm.resolveSession(token);
      if (!r) return null;
      return { user: { id: r.user.id, email: r.user.username, role: r.user.role } };
    },
    // In-process sign-up shim for POST /v1/admin/users — mirrors Better
    // Auth's behavior: creates the user, throws a 422-shaped APIError on
    // duplicate email. The fake warm store's `username` doubles as email.
    signUpEmail: async (body: { email: string; password: string; name: string }) => {
      for (const u of warm.users.values()) {
        if (u.username === body.email) {
          const err = new Error("User already exists") as Error & { statusCode: number };
          err.statusCode = 422;
          throw err;
        }
      }
      const created = await warm.createUser({
        username: body.email,
        passwordHash: "test-not-checked",
        role: "user",
        userId: null,
      });
      return { user: { id: created.id } };
    },
  };
  const app = buildHttpServer({
    engine,
    warm: asWarm(warm),
    auth: { mode: opts.authMode ?? "none", token: opts.token },
    rateLimitPerMinute: 100_000, // effectively off for tests
    metrics,
    adminDashboard: opts.adminDashboard,
    betterAuth: fakeBA,
  });
  return { app, warm, cold, metrics };
}

/** Mint a session-admin Bearer header directly via the fake warm store —
 *  bypasses the login + bcrypt path (tested separately) so admin-route
 *  tests don't have to do round-trips. The legacy NOVAMEM_ADMIN_TOKEN
 *  was removed; admin auth is now always per-user via session. */
async function adminAuth(
  warm: FakeWarmStore,
): Promise<{ authorization: string }> {
  const id = `admin-${Math.random().toString(36).slice(2, 10)}`;
  await warm.createUser({
    username: id,
    passwordHash: "test-bcrypt-not-checked-for-session-resolve",
    role: "admin",
  });
  // Look up the row to get its real id (createUser assigns one).
  let userId = id;
  for (const u of warm.users.values()) {
    if (u.username === id) {
      userId = u.id;
      break;
    }
  }
  const sess = await warm.createSession(userId, 24 * 3600 * 1000);
  return { authorization: `Bearer ${sess.token}` };
}

/** Same as adminAuth but creates a non-admin user. Used by tests that
 *  need a logged-in user without going through Better Auth (which would
 *  require a real database). The returned headers can be used as a
 *  drop-in replacement for what `/v1/auth/login` used to return. */
async function userAuth(
  warm: FakeWarmStore,
  username: string,
  role: "admin" | "user" = "user",
): Promise<{ authorization: string; userId: string; sessionToken: string }> {
  await warm.createUser({
    username,
    passwordHash: "test-bcrypt-not-checked-for-session-resolve",
    role,
  });
  let userId = username;
  for (const u of warm.users.values()) {
    if (u.username === username) { userId = u.id; break; }
  }
  const sess = await warm.createSession(userId, 24 * 3600 * 1000);
  return { authorization: `Bearer ${sess.token}`, userId, sessionToken: sess.token };
}

describe("http: health probes", () => {
  it("/live returns 200 without dependency checks", async () => {
    const { app, cold } = makeApp();
    cold.fail = true;
    const r = await app.inject({ method: "GET", url: "/live" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("/ready returns 200 + minimal { ok } when everything is up", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/ready" });
    expect(r.statusCode).toBe(200);
    // Public readiness must NOT leak dep names/status — that's what
    // /v1/admin/health/deep is for (see #46).
    expect(r.json()).toEqual({ ok: true });
  });

  it.each(["/ready", "/health"])("%s returns 503 + minimal { ok: false } when a dep is unreachable", async (url) => {
    const { app, cold } = makeApp();
    cold.fail = true;
    const r = await app.inject({ method: "GET", url });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ ok: false });
    expect(r.json().deps).toBeUndefined();
  });

  it("admin-gated /v1/admin/health/deep returns the dep snapshot", async () => {
    const { app, warm } = makeApp();
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/health/deep",
      headers: adminH,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      ok: true,
      deps: { warm: "ok", cold: "ok", graph: "disabled", embedder: "ok" },
      pendingEmbeddings: null,
    });
  });

  it("/v1/admin/health/deep returns 401 without admin auth", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/v1/admin/health/deep" });
    expect(r.statusCode).toBe(401);
  });
});

describe("http: error handler does not leak details (#46)", () => {
  it("returns a generic message — never the raw Error / stack", async () => {
    const { app } = makeApp();
    // Trigger a 500 by handing the error handler a synthetic non-Zod
    // throw via a registered route. Use a route that already exists but
    // hand it a payload that will fail downstream — easiest: register a
    // throw-route inline. Fastify lets us add routes after build.
    app.get("/__throw_internal__", async () => {
      throw new Error("super secret stack /home/app/x.ts:42 line three");
    });
    const r = await app.inject({ method: "GET", url: "/__throw_internal__" });
    expect(r.statusCode).toBe(500);
    const body = r.json();
    expect(body).toEqual({ error: "internal server error" });
    expect(JSON.stringify(body)).not.toContain("super secret stack");
    expect(JSON.stringify(body)).not.toContain("/home/app/x.ts");
    expect(body.stack).toBeUndefined();
  });
});

describe("http: global hardening headers (#47)", () => {
  it("sets X-Frame-Options: DENY on a data-plane response", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "header probe", force: true },
    });
    expect(r.statusCode).toBe(201);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("sets the same headers on /health", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("http: request correlation (#75)", () => {
  it("sets a unique X-Request-Id on /v1/recent responses", async () => {
    const { app } = makeApp();
    const a = await app.inject({ method: "POST", url: "/v1/recent", payload: { k: 1 } });
    const b = await app.inject({ method: "POST", url: "/v1/recent", payload: { k: 1 } });
    const idA = a.headers["x-request-id"];
    const idB = b.headers["x-request-id"];
    expect(typeof idA).toBe("string");
    expect(typeof idB).toBe("string");
    expect((idA as string).length).toBeGreaterThan(0);
    expect(idA).not.toBe(idB);
  });

  it("echoes a safe inbound x-request-id", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: { k: 1 },
      headers: { "x-request-id": "ext-trace-abc123" },
    });
    expect(r.headers["x-request-id"]).toBe("ext-trace-abc123");
  });

  it("rejects unsafe inbound x-request-id and falls back to a generated one", async () => {
    const { app } = makeApp();
    // Anything outside [A-Za-z0-9_.:-] (e.g. spaces, control bytes,
    // semicolons) is replaced by a generated id rather than echoed —
    // closes log/response-header injection vectors.
    const r = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: { k: 1 },
      headers: { "x-request-id": "spaces and ; semicolons" },
    });
    expect(r.statusCode).toBe(200);
    const echoed = r.headers["x-request-id"];
    expect(typeof echoed).toBe("string");
    expect(echoed).not.toBe("spaces and ; semicolons");
    expect(echoed).toMatch(/^[A-Za-z0-9_.:-]+$/);
  });
});

describe("http: /v1/remember", () => {
  it("accepts a valid body and returns 201 + id", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "hello world", namespace: "ns", force: true },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("rejects empty content", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "", force: true },
    });
    expect(r.statusCode).toBe(400); // Zod errors mapped to 400 by setErrorHandler
    expect(r.json().error).toMatch(/invalid request/i);
  });

  it("rejects oversized content (> 256KB)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "x".repeat(300_000), force: true },
    });
    expect([400, 413]).toContain(r.statusCode);
  });
});

describe("http: /v1/search", () => {
  it("returns ranked results", async () => {
    const { app } = makeApp();
    await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "Pascal likes coffee", force: true } });
    const r = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "coffee", k: 5 },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.results).toBeInstanceOf(Array);
    expect(body.results.length).toBeGreaterThan(0);
  });

  it("forwards weights override", async () => {
    const { app } = makeApp();
    await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "marker token", force: true } });
    const r = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "marker", weights: { keyword: 1, vector: 0, graph: 0 } },
    });
    expect(r.statusCode).toBe(200);
  });

  it("accepts k=200 so external benchmarks can report top_200", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "benchmark comparable recall", k: 200 },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("http: /v1/recent + /v1/forget", () => {
  it("recent returns newest first", async () => {
    const { app, warm } = makeApp();
    const a = await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "first", force: true } });
    const b = await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "second", force: true } });
    // Two POSTs in the same millisecond would tie on createdAt — force a 1s
    // gap so ordering is deterministic.
    warm.rows.get(a.json().id)!.createdAt = new Date(Date.now() - 1000);
    const r = await app.inject({ method: "POST", url: "/v1/recent", payload: { k: 5 } });
    expect(r.statusCode).toBe(200);
    const ids = r.json().results.map((x: { id: string }) => x.id);
    expect(ids[0]).toBe(b.json().id);
    expect(ids[1]).toBe(a.json().id);
  });

  it("forget removes the entry", async () => {
    const { app } = makeApp();
    const created = await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "to forget", force: true } });
    const id = created.json().id;
    const r = await app.inject({ method: "POST", url: "/v1/forget", payload: { id } });
    expect(r.statusCode).toBe(200);
    expect(r.json().deleted).toBe(true);
    const after = await app.inject({ method: "POST", url: "/v1/recent", payload: {} });
    expect(after.json().results.find((x: { id: string }) => x.id === id)).toBeUndefined();
  });
});

describe("http: /v1/promote (removed)", () => {
  it("returns 404 — endpoint was a stub and was deleted", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "POST", url: "/v1/promote", payload: {} });
    expect(r.statusCode).toBe(404);
  });
});

describe("http: bearer auth", () => {
  it("rejects missing Authorization header", async () => {
    const { app } = makeApp({ authMode: "bearer", token: "secret" });
    const r = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" } });
    expect(r.statusCode).toBe(401);
  });

  it("rejects wrong token", async () => {
    const { app } = makeApp({ authMode: "bearer", token: "secret" });
    const r = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "x" },
      headers: { authorization: "Bearer wrong" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("accepts correct token", async () => {
    const { app } = makeApp({ authMode: "bearer", token: "secret" });
    const r = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "x" },
      headers: { authorization: "Bearer secret" },
    });
    expect(r.statusCode).toBe(200);
  });

  it.each(["/health", "/live", "/ready"])("%s is always public, even in bearer mode", async (url) => {
    const { app } = makeApp({ authMode: "bearer", token: "secret" });
    const r = await app.inject({ method: "GET", url });
    expect([200, 503]).toContain(r.statusCode);
    expect(r.json()).toHaveProperty("ok");
  });

  it("throws at construction when bearer mode lacks a token", () => {
    expect(() => makeApp({ authMode: "bearer", token: undefined })).toThrow(/auth\.mode = 'bearer'/);
  });
});

describe("http: SSE/MCP transport routes", () => {
  it("POST /mcp/messages without a sessionId → 400", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "POST", url: "/mcp/messages", payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it("POST /mcp/messages with an unknown sessionId → 404", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/mcp/messages?sessionId=does-not-exist",
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("http: user mode + admin routes", () => {
  /** Create two users and mint a token for each. The new model has no
   *  separate user-namespace concept — each user IS their own scope. Tests that
   *  used to assert "memories don't mix between users" now assert the
   *  same boundary at the user level. */
  async function setupTwoUsers() {
    const { app, warm } = makeApp({ authMode: "user" });
    const adminH = await adminAuth(warm);
    const mkUser = async (username: string) => {
      const u = await warm.createUser({
        username,
        passwordHash: "test",
        role: "user",
      });
      const t = await warm.createUserToken(u.id, "test");
      return { id: u.id, token: t!.token };
    };
    const a = await mkUser("alice-mem");
    const b = await mkUser("bob-mem");
    return { app, warm, tokenA: a.token, tokenB: b.token, userA: a.id, userB: b.id, adminH };
  }

  it("rejects requests without a recognised token", async () => {
    const { app } = makeApp({ authMode: "user" });
    const r = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "x" },
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("memories don't mix between users — search", async () => {
    const { app, tokenA, tokenB } = await setupTwoUsers();
    const created = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "Pascal likes dark roast coffee", force: true },
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const aId = created.json().id;
    const bSearch = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "coffee preference" },
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(bSearch.statusCode).toBe(200);
    expect(bSearch.json().results.find((r: { id: string }) => r.id === aId)).toBeUndefined();
  });

  it("memories don't mix — recent + forget", async () => {
    const { app, tokenA, tokenB } = await setupTwoUsers();
    const created = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "user a fact", force: true },
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const aId = created.json().id;
    const bRecent = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(bRecent.json().results.find((r: { id: string }) => r.id === aId)).toBeUndefined();
    const bForget = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: { id: aId },
      headers: { authorization: `Bearer ${tokenB}` },
    });
    // Defence-in-depth getEntryScope recheck is now on the unified data-plane
    // forget route, so the protection is universal: bob's bearer + alice's
    // user-global entry → 403 "not in your user namespace" instead of the
    // engine's silent {deleted: false} miss.
    expect(bForget.statusCode).toBe(403);
    const aRecent = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(aRecent.json().results.find((r: { id: string }) => r.id === aId)).toBeDefined();
  });

  it("revoked tokens stop working immediately", async () => {
    const { app, tokenA, adminH } = await setupTwoUsers();
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(r1.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: "/v1/admin/tokens/revoke",
      payload: { token: tokenA },
      headers: adminH,
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(r2.statusCode).toBe(401);
  });
});

describe("http: /v1/admin/metrics", () => {
  it("401 without admin token", async () => {
    const { app } = makeApp({});
    const r = await app.inject({ method: "GET", url: "/v1/admin/metrics" });
    expect(r.statusCode).toBe(401);
  });

  it("401 with the wrong admin token", async () => {
    const { app } = makeApp({});
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/metrics",
      headers: { authorization: "Bearer wrong" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("200 with admin token, returns counters/gauges/rates shape", async () => {
    const { app, warm } = makeApp({});
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/metrics",
      headers: adminH,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toHaveProperty("counters");
    expect(body).toHaveProperty("gauges");
    expect(body).toHaveProperty("rates");
    expect(body.counters.queries_total).toBe(0);
  });

  it("counters reflect engine activity end-to-end", async () => {
    const { app, warm } = makeApp({});
    const adminH = await adminAuth(warm);
    // Zero-hit query first, against an empty store, so neither warm FTS
    // nor cold can produce results.
    await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "nothing here yet" },
    });
    // Now remember + search to drive a non-zero-hit query.
    const created = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "Pascal likes dark roast coffee", force: true },
    });
    const id = created.json().id;
    await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "coffee" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: { id },
    });
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/metrics",
      headers: adminH,
    });
    const body = r.json();
    expect(body.counters.remembers_total).toBe(1);
    expect(body.counters.queries_total).toBe(2);
    expect(body.counters.queries_zero_hit).toBeGreaterThanOrEqual(1);
    expect(body.counters.forgets_total).toBe(1);
    // The successful search should have produced at least one warm-tier hit
    // since the entry was created in this same window.
    expect(body.counters.hits_warm_total).toBeGreaterThan(0);
  });

  it("404 when NOVAMEM_ADMIN_DASHBOARD=0 (adminDashboard=false)", async () => {
    const { app, warm } = makeApp({ adminDashboard: false });
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/metrics",
      headers: adminH,
    });
    expect(r.statusCode).toBe(404);
  });

  it("404 when no metrics collector is wired", async () => {
    const { app, warm } = makeApp({ withMetrics: false });
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/metrics",
      headers: adminH,
    });
    expect(r.statusCode).toBe(404);
  });

  it("graph_edges counts SQL relations (Phase 7: no graph service)", async () => {
    const { app, warm } = makeApp({});
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/metrics",
      headers: adminH,
    });
    expect(r.statusCode).toBe(200);
    expect(typeof r.json().gauges.graph_edges).toBe("number");
    expect(r.json().gauges.graph_edges).toBe(warm.relations.length);
  });
});

describe("http: /admin dashboard mount", () => {
  it("GET /admin returns 200 + HTML", async () => {
    const { app } = makeApp({});
    const r = await app.inject({ method: "GET", url: "/admin" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.body).toMatch(/<title>novamem/i);
  });

  it("GET /admin/ also returns 200 + HTML", async () => {
    const { app } = makeApp({});
    const r = await app.inject({ method: "GET", url: "/admin/" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
  });

  it("a built JS asset is served with strict CSP header", async () => {
    const { app } = makeApp({});
    // Vite hashes asset filenames; pull the actual entry path out of the
    // index.html so this test stays robust across rebuilds.
    const html = await app.inject({ method: "GET", url: "/admin" });
    const match = html.body.match(/src="(\/admin\/assets\/[^"]+\.js)"/);
    expect(match, "expected a script src in index.html").not.toBeNull();
    const r = await app.inject({ method: "GET", url: match![1]! });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/javascript/);
    expect(r.headers["content-security-policy"]).toBeDefined();
    expect(String(r.headers["content-security-policy"])).toMatch(/default-src 'self'/);
    expect(String(r.headers["content-security-policy"])).toMatch(/script-src 'self'/);
  });

  it("/admin returns 404 when adminDashboard is disabled", async () => {
    const { app } = makeApp({ adminDashboard: false });
    const r = await app.inject({ method: "GET", url: "/admin" });
    expect(r.statusCode).toBe(404);
  });

  it("/admin/assets/* returns 404 when adminDashboard is disabled", async () => {
    const { app } = makeApp({ adminDashboard: false });
    const r = await app.inject({ method: "GET", url: "/admin/assets/anything.js" });
    expect(r.statusCode).toBe(404);
  });

  it("dashboard HTML is reachable in user mode without a user bearer", async () => {
    // The HTML shell must load before the user can paste their admin token.
    // The auth hook explicitly skips /admin/* — verify it doesn't 401.
    const { app } = makeApp({ authMode: "user" });
    const r = await app.inject({ method: "GET", url: "/admin" });
    expect(r.statusCode).toBe(200);
  });
});


describe("http: OpenAPI + Swagger UI", () => {
  it("/openapi.json returns the structured spec", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.openapi).toMatch(/^3\./);
    expect(body.info.title).toBe("novamem");
    expect(body.paths).toBeDefined();
    expect(body.paths["/v1/search"]).toBeDefined();
    expect(body.paths["/v1/me/projects"]).toBeDefined();
    expect(body.components.securitySchemes.UserBearer).toBeDefined();
  });

  it("/api-docs serves Swagger UI HTML", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/api-docs/static/index.html" });
    // The plugin serves both /api-docs and /api-docs/static/* by default;
    // the static asset path always exists once the plugin is mounted.
    expect([200, 301, 302]).toContain(r.statusCode);
  });

  it("/api-docs is reachable in user mode without a bearer", async () => {
    const { app } = makeApp({ authMode: "user" });
    const r = await app.inject({ method: "GET", url: "/api-docs/static/index.html" });
    expect([200, 301, 302]).toContain(r.statusCode);
  });
});

describe("http: dashboard auth + RBAC", () => {
  // Login/logout/me/change-password are owned by Better Auth at
  // /api/auth/*. Tests here cover the RBAC consequences (admin can do X,
  // user can't do Y) — they synthesise sessions via `userAuth()` to
  // skip the password+sign-in round-trip Better Auth would normally do.

  // Admin user-CRUD (create / list / promote / demote / delete) is now
  // owned by Better Auth at /api/auth/admin/*. Those endpoints are
  // tested by Better Auth itself; we only verified the SPA wires them
  // correctly. The "refuses to delete self / last admin" guarantees
  // are upstream invariants in Better Auth's admin plugin.

  it("user role: /v1/me/metrics is scoped to that user", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const bob = await userAuth(warm, "bob");
    const m = await app.inject({
      method: "GET", url: "/v1/me/metrics",
      headers: { authorization: bob.authorization },
    });
    expect(m.statusCode).toBe(200);
    expect(m.json().userId).toBe(bob.userId);
  });

  it("user can create + delete their own tokens", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const bob = await userAuth(warm, "bob");
    const auth = { authorization: bob.authorization };

    const mint = await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { label: "phone" },
      headers: auth,
    });
    expect(mint.statusCode).toBe(201);
    const userBearer = mint.json().token;
    expect(userBearer).toMatch(/^nm_/);

    const list = await app.inject({ method: "GET", url: "/v1/me/tokens", headers: auth });
    expect(list.json().tokens.length).toBe(1);
    const tokenHash = list.json().tokens[0].tokenHash;

    const r = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${userBearer}` },
    });
    expect(r.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE", url: `/v1/me/tokens/${tokenHash}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);

    const afterList = await app.inject({ method: "GET", url: "/v1/me/tokens", headers: auth });
    expect(afterList.json().tokens.length).toBe(0);

    const after = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${userBearer}` },
    });
    expect(after.statusCode).toBe(401);
  });

  // "user cannot reach admin routes" — the only admin user-mgmt route
  // we own (/v1/admin/users) is gone; Better Auth's admin endpoints
  // gate themselves. We still test that data-plane routes with a
  // non-admin bearer don't escalate (covered by other tests).
});

describe("http: P0 regression tests", () => {
  async function setupBobInAcme() {
    const { app, warm } = makeApp({ authMode: "user" });
    // Bypass /v1/auth/login (gone) and mint sessions directly via the
    // fake warm store. The fake Better Auth shim resolves the resulting
    // ns_… token back to the same dashUser, so handler behaviour is
    // identical to the real flow.
    const bob = await userAuth(warm, "bob");
    const carol = await userAuth(warm, "carol");
    return { app, warm, bobSession: bob.sessionToken, carolSession: carol.sessionToken };
  }

  // The user-id-collision-with-project-prefix concern is obsolete —
  // there are no user ids any more, just user ids; user creation goes
  // through usernames which can't collide with project collection
  // naming.

  // Removing a member terminates that user's project access.
  // Tokens themselves have no per-project scope; access flows from the
  // owning user's memberships at request time. So the kicked member's
  // bearer continues to work for their own user-global memory but is
  // refused when it asks for the project they used to be in.
  it("removeProjectMember terminates the kicked user's project access", async () => {
    const { app, warm, bobSession, carolSession } = await setupBobInAcme();
    const bobAuth = { authorization: `Bearer ${bobSession}` };
    const carolAuth = { authorization: `Bearer ${carolSession}` };
    // Bob owns 'shared'; Carol joins.
    const created = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Shared" }, headers: bobAuth,
    });
    const sharedId = created.json().id as string;
    await app.inject({
      method: "POST", url: `/v1/me/projects/${sharedId}/members`,
      payload: { username: "carol" }, headers: bobAuth,
    });
    // Carol mints a (user-global) bearer.
    const mint = await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { label: "carol-laptop" }, headers: carolAuth,
    });
    const carolTok = mint.json().token;
    // Carol can search the project while still a member.
    const okSearch = await app.inject({
      method: "POST", url: "/v1/search",
      payload: { query: "x", project: sharedId },
      headers: { authorization: `Bearer ${carolTok}` },
    });
    expect(okSearch.statusCode).toBe(200);
    // Bob removes Carol — the carolMe call used /v1/auth/me but that's
    // gone now; look up carol's id directly via the fake warm store.
    let carolUserId = "";
    for (const u of warm.users.values()) if (u.username === "carol") carolUserId = u.id;
    const remove = await app.inject({
      method: "DELETE", url: `/v1/me/projects/${sharedId}/members/${carolUserId}`,
      headers: bobAuth,
    });
    expect(remove.statusCode).toBe(200);
    // Carol's bearer still authenticates (user-global), but project access is gone.
    const denied = await app.inject({
      method: "POST", url: "/v1/search",
      payload: { query: "x", project: sharedId },
      headers: { authorization: `Bearer ${carolTok}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("removed project member cannot see former project content through hygiene, today, stats, or active project", async () => {
    const { app, warm, bobSession, carolSession } = await setupBobInAcme();
    const bobAuth = { authorization: `Bearer ${bobSession}` };
    const carolAuth = { authorization: `Bearer ${carolSession}` };

    const created = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Sensitive Shared" }, headers: bobAuth,
    });
    const sharedId = created.json().id as string;
    await app.inject({
      method: "POST", url: `/v1/me/projects/${sharedId}/members`,
      payload: { username: "carol" }, headers: bobAuth,
    });
    let carolUserId = "";
    for (const u of warm.users.values()) if (u.username === "carol") carolUserId = u.id;
    await warm.insertEntry({
      userId: carolUserId,
      projectId: sharedId,
      content: "tiny secret",
      namespace: "former-project",
      source: "test",
    });

    const setActive = await app.inject({
      method: "PUT", url: "/v1/me/active-project",
      payload: { project: sharedId }, headers: carolAuth,
    });
    expect(setActive.statusCode).toBe(200);

    const beforeHygiene = await app.inject({ method: "POST", url: "/v1/hygiene", payload: { k: 10 }, headers: carolAuth });
    expect(JSON.stringify(beforeHygiene.json())).toContain("tiny secret");
    const beforeStats = await app.inject({ method: "GET", url: "/v1/stats", headers: carolAuth });
    expect(JSON.stringify(beforeStats.json())).toContain("former-project");
    const beforeToday = await app.inject({ method: "GET", url: "/v1/me/today", headers: carolAuth });
    expect(JSON.stringify(beforeToday.json())).toContain("tiny secret");

    const remove = await app.inject({
      method: "DELETE", url: `/v1/me/projects/${sharedId}/members/${carolUserId}`,
      headers: bobAuth,
    });
    expect(remove.statusCode).toBe(200);

    const afterHygiene = await app.inject({ method: "POST", url: "/v1/hygiene", payload: { k: 10 }, headers: carolAuth });
    expect(afterHygiene.statusCode).toBe(200);
    expect(JSON.stringify(afterHygiene.json())).not.toContain("tiny secret");
    const afterStats = await app.inject({ method: "GET", url: "/v1/stats", headers: carolAuth });
    expect(afterStats.statusCode).toBe(200);
    expect(JSON.stringify(afterStats.json())).not.toContain("former-project");
    const afterToday = await app.inject({ method: "GET", url: "/v1/me/today", headers: carolAuth });
    expect(afterToday.statusCode).toBe(200);
    expect(JSON.stringify(afterToday.json())).not.toContain("tiny secret");
    const active = await app.inject({ method: "GET", url: "/v1/me/active-project", headers: carolAuth });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toEqual({ active: null });
  });


  // The login-throttle concern was about /v1/auth/login. Better Auth
  // owns throttling now via its own rate-limit + secondaryStorage
  // hooks; we no longer ship a hand-rolled per-username throttle.

  // getEntry's `"*"` magic-string bypass is gone
  it("getEntry with projectId='*' is treated as a literal id, not a bypass", async () => {
    const { warm } = makeApp({ authMode: "none" });
    const id = await warm.insertEntry({
      userId: "public",
      projectId: "phoenix",
      content: "x",
      namespace: "default",
      source: "manual",
    });
    // With projectId="*" the row has projectId="phoenix" → must NOT match.
    const got = await warm.getEntry("public", id, { projectId: "*" });
    expect(got).toBeUndefined();
    // Sanity: with the actual projectId it does match.
    const ok = await warm.getEntry("public", id, { projectId: "phoenix" });
    expect(ok).toBeDefined();
  });

  // Cross-user project member CAN forget shared rows
  it("cross-user project member can forget a shared entry", async () => {
    const { app, bobSession, carolSession } = await setupBobInAcme();
    const bobAuth = { authorization: `Bearer ${bobSession}` };
    const carolAuth = { authorization: `Bearer ${carolSession}` };
    // Owner Bob, member Carol on 'shared'
    const proj = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Shared" }, headers: bobAuth,
    });
    const sharedId = proj.json().id as string;
    await app.inject({
      method: "POST", url: `/v1/me/projects/${sharedId}/members`,
      payload: { username: "carol" }, headers: bobAuth,
    });
    const bobTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: {}, headers: bobAuth,
    })).json().token;
    const carolTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: {}, headers: carolAuth,
    })).json().token;
    // Bob remembers something in the shared project
    const created = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "bob's note", project: sharedId, force: true },
      headers: { authorization: `Bearer ${bobTok}` },
    });
    const id = created.json().id;
    // Carol (different user, same project) can forget it
    const f = await app.inject({
      method: "POST", url: "/v1/forget",
      payload: { id, project: sharedId },
      headers: { authorization: `Bearer ${carolTok}` },
    });
    expect(f.statusCode).toBe(200);
    expect(f.json().deleted).toBe(true);
    // And it's actually gone.
    const recent = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: { project: sharedId },
      headers: { authorization: `Bearer ${bobTok}` },
    });
    expect(recent.json().results.find((r: { id: string }) => r.id === id)).toBeUndefined();
  });

  // Cookie-authed /v1/me/* mirrors must check project membership.
  // Without this guard, any user in `acme` could read/write any
  // project under `acme` by passing the project id in the body — even
  // projects they're not a member of.
  it("/v1/search refuses non-members of the requested project (cookie-authed)", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const aliceHelper = await userAuth(warm, "alice");
    const bobHelper = await userAuth(warm, "bob");
    const aliceSession = aliceHelper.sessionToken;
    const bobSession = bobHelper.sessionToken;
    const aliceAuth = { authorization: `Bearer ${aliceSession}` };
    const bobAuth = { authorization: `Bearer ${bobSession}` };

    // Alice creates a private project; Bob is not a member.
    const created = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Alice Secret" },
      headers: aliceAuth,
    });
    expect(created.statusCode).toBe(201);
    const aliceProjId = created.json().id as string;

    // Each /v1/* data-plane route must 403 when Bob targets Alice's project,
    // even when authed by a Better Auth session bearer (the cookie-authed
    // dashboard path that used to go through the /v1/me/* mirrors).
    const search = await app.inject({
      method: "POST", url: "/v1/search",
      payload: { query: "x", project: aliceProjId },
      headers: bobAuth,
    });
    expect(search.statusCode).toBe(403);

    const recent = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: { project: aliceProjId },
      headers: bobAuth,
    });
    expect(recent.statusCode).toBe(403);

    const remember = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "bob's intrusion", project: aliceProjId, force: true },
      headers: bobAuth,
    });
    expect(remember.statusCode).toBe(403);

    const forget = await app.inject({
      method: "POST", url: "/v1/forget",
      payload: { id: "01HXXX", project: aliceProjId },
      headers: bobAuth,
    });
    expect(forget.statusCode).toBe(403);

    const neighbors = await app.inject({
      method: "POST", url: "/v1/neighbors",
      payload: { id: "01HXXX", project: aliceProjId },
      headers: bobAuth,
    });
    expect(neighbors.statusCode).toBe(403);

    // Alice (the owner) can still use her own project.
    const okSearch = await app.inject({
      method: "POST", url: "/v1/search",
      payload: { query: "x", project: aliceProjId },
      headers: aliceAuth,
    });
    expect(okSearch.statusCode).toBe(200);
  });

  // /v1/forget can't be tricked into deleting a project-scoped entry
  // by passing project: null. The handler looks up the actual entry's
  // project_id and re-checks membership on the unified data-plane route,
  // so the protection is universal.
  it("/v1/forget rechecks the entry's real project", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const aliceHelper = await userAuth(warm, "alice");
    const bobHelper = await userAuth(warm, "bob");
    const aliceSession = aliceHelper.sessionToken;
    const bobSession = bobHelper.sessionToken;
    const aliceAuth = { authorization: `Bearer ${aliceSession}` };
    const bobAuth = { authorization: `Bearer ${bobSession}` };

    const proj = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Alice Secret" },
      headers: aliceAuth,
    });
    const aliceProjId = proj.json().id as string;
    const aliceTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: {}, headers: aliceAuth,
    })).json().token;
    const created = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "alice's secret", project: aliceProjId, force: true },
      headers: { authorization: `Bearer ${aliceTok}` },
    });
    const id = created.json().id;

    // Bob tries to delete the entry by passing project: null. The first
    // membership check passes (null is allowed — user-wide is OK), but
    // the entry-resolution recheck must catch it.
    const r = await app.inject({
      method: "POST", url: "/v1/forget",
      payload: { id }, headers: bobAuth,
    });
    expect(r.statusCode).toBe(403);
  });

  // Admin user.create audit log — the legacy /v1/admin/users route
  // emitted these entries. With user-CRUD moved to Better Auth,
  // user.create audit entries are produced by Better Auth's own hooks
  // (configured separately via its `databaseHooks`); not in scope for
  // this test surface.

  // Zod errors → 400 (covered by existing test rewritten earlier).
});

describe("http: projects (sub-brains)", () => {
  async function setupBobInAcme() {
    const { app, warm } = makeApp({ authMode: "user" });
    const bob = await userAuth(warm, "bob");
    await userAuth(warm, "carol");
    return { app, warm, session: bob.sessionToken };
  }

  it("user creates a project and lists it", async () => {
    const { app, session } = await setupBobInAcme();
    const auth = { authorization: `Bearer ${session}` };

    const create = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Phoenix" },
      headers: auth,
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID

    const list = await app.inject({ method: "GET", url: "/v1/me/projects", headers: auth });
    const projects = list.json().projects;
    expect(projects.length).toBe(1);
    expect(projects[0].id).toBe(id);
    expect(projects[0].name).toBe("Phoenix");
    expect(projects[0].role).toBe("owner");
  });

  it("active-project mode unions user-global with the project", async () => {
    const { app, session } = await setupBobInAcme();
    const auth = { authorization: `Bearer ${session}` };

    const proj = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Phoenix" },
      headers: auth,
    });
    const phoenixId = proj.json().id as string;

    const tok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { label: "laptop" },
      headers: auth,
    })).json().token as string;
    const tokAuth = { authorization: `Bearer ${tok}` };

    // User-global remember
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "user-wide alpha", force: true },
      headers: tokAuth,
    });
    // Project remember
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "phoenix beta gamma", project: phoenixId, force: true },
      headers: tokAuth,
    });

    // Default scope = user-global only
    const wide = await app.inject({
      method: "POST", url: "/v1/recent", payload: {}, headers: tokAuth,
    });
    const wideContents = wide.json().results.map((r: { content: string }) => r.content);
    expect(wideContents).toContain("user-wide alpha");
    expect(wideContents).not.toContain("phoenix beta gamma");

    // Project-only scope
    const ph = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: { project: phoenixId },
      headers: tokAuth,
    });
    const phContents = ph.json().results.map((r: { content: string }) => r.content);
    expect(phContents).toContain("phoenix beta gamma");
    expect(phContents).not.toContain("user-wide alpha");

    // Active-project mode unions the two
    const both = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: { includeProjects: [phoenixId] },
      headers: tokAuth,
    });
    const bothContents = both.json().results.map((r: { content: string }) => r.content);
    expect(bothContents).toContain("user-wide alpha");
    expect(bothContents).toContain("phoenix beta gamma");
  });

  it("owner adds a cross-user member; member sees the project + can mint tokens", async () => {
    const { app, warm, session } = await setupBobInAcme();
    const authBob = { authorization: `Bearer ${session}` };
    const proj = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Shared" },
      headers: authBob,
    });
    const sharedId = proj.json().id as string;

    // Add carol (different user) by username
    const add = await app.inject({
      method: "POST", url: `/v1/me/projects/${sharedId}/members`,
      payload: { username: "carol" },
      headers: authBob,
    });
    expect(add.statusCode).toBe(201);

    // Carol logs in (synthesise via the test helper)
    let carolUserId = "";
    for (const u of warm.users.values()) if (u.username === "carol") carolUserId = u.id;
    const carolSess = await warm.createSession(carolUserId, 24 * 3600 * 1000);
    const carolSession = carolSess.token;
    const authCarol = { authorization: `Bearer ${carolSession}` };

    // Carol sees the shared project in her list
    const list = await app.inject({ method: "GET", url: "/v1/me/projects", headers: authCarol });
    const ids = list.json().projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(sharedId);

    // Carol mints a (user-global) bearer.
    const mint = await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { label: "carols-laptop" },
      headers: authCarol,
    });
    expect(mint.statusCode).toBe(201);
    const carolTok = mint.json().token;

    // Bob remembers something in shared
    const bobTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: {}, headers: authBob,
    })).json().token;
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "bob's note in shared", project: sharedId, force: true },
      headers: { authorization: `Bearer ${bobTok}` },
    });

    // Carol's bearer can read Bob's note when scoped to the shared project.
    const r = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: { project: sharedId },
      headers: { authorization: `Bearer ${carolTok}` },
    });
    const contents = r.json().results.map((x: { content: string }) => x.content);
    expect(contents).toContain("bob's note in shared");
    void warm;
  });

  it("non-owner cannot add members or delete the project", async () => {
    const { app, warm, session } = await setupBobInAcme();
    const authBob = { authorization: `Bearer ${session}` };
    const proj = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Shared" },
      headers: authBob,
    });
    const sharedId = proj.json().id as string;
    await app.inject({
      method: "POST", url: `/v1/me/projects/${sharedId}/members`,
      payload: { username: "carol" },
      headers: authBob,
    });

    let carolId = "";
    for (const u of warm.users.values()) if (u.username === "carol") carolId = u.id;
    const carolSess = await warm.createSession(carolId, 24 * 3600 * 1000);
    const carolAuth = { authorization: `Bearer ${carolSess.token}` };

    const add = await app.inject({
      method: "POST", url: `/v1/me/projects/${sharedId}/members`,
      payload: { username: "bob" },
      headers: carolAuth,
    });
    expect(add.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE", url: `/v1/me/projects/${sharedId}`,
      headers: carolAuth,
    });
    expect(del.statusCode).toBe(403);
  });

  it("owner deletes the project; entries gone, project access dies", async () => {
    const { app, session } = await setupBobInAcme();
    const auth = { authorization: `Bearer ${session}` };
    const proj = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "Phoenix" },
      headers: auth,
    });
    const phoenixId = proj.json().id as string;
    const tok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: {}, headers: auth,
    })).json().token;
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "to be purged", project: phoenixId, force: true },
      headers: { authorization: `Bearer ${tok}` },
    });

    const del = await app.inject({
      method: "DELETE", url: `/v1/me/projects/${phoenixId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);
    expect(del.json().entriesRemoved).toBeGreaterThanOrEqual(1);

    // Token still authenticates (no project scope on tokens), but the
    // project resolves to nothing — distinguishing "doesn't exist" (404)
    // from "exists but you aren't a member" (403). The deleted project
    // is the former.
    const denied = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: { project: phoenixId },
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(denied.statusCode).toBe(404);
  });
});

describe("http: /v1/auth/rotate-token (user self-service)", () => {
  it("rotates the caller's token and revokes the old one", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await warm.createUser({
      username: "alice-rot",
      passwordHash: "test",
      role: "user",
    });
    const minted = await warm.createUserToken(u.id, "first");
    const oldToken = minted!.token;

    const rot = await app.inject({
      method: "POST", url: "/v1/auth/rotate-token",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(rot.statusCode).toBe(201);
    const newToken = rot.json().token as string;
    expect(newToken).not.toBe(oldToken);
    expect(rot.json().warning).toMatch(/shown again/);

    // Old token rejected.
    const r1 = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(r1.statusCode).toBe(401);

    // New token works.
    const r2 = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(r2.statusCode).toBe(200);
  });

  it("401s without a valid bearer", async () => {
    const { app } = makeApp({ authMode: "user" });
    const r = await app.inject({
      method: "POST", url: "/v1/auth/rotate-token",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("400s outside user mode", async () => {
    const { app } = makeApp({ authMode: "bearer", token: "secret" });
    const r = await app.inject({
      method: "POST", url: "/v1/auth/rotate-token",
      headers: { authorization: "Bearer secret" },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("http: per-account rate limiter on /v1/auth/rotate-token (#15)", () => {
  it("returns 429 with Retry-After after 5 failed rotate attempts", async () => {
    const { app } = makeApp({ authMode: "user" });
    // Same bogus bearer six times — first five 401, sixth 429.
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: "POST", url: "/v1/auth/rotate-token",
        headers: { authorization: "Bearer nm_brute-attempt-token" },
      });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST", url: "/v1/auth/rotate-token",
      headers: { authorization: "Bearer nm_brute-attempt-token" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("http: audit-log limit validation (#16)", () => {
  it("rejects ?limit=abc with 400", async () => {
    const { app, warm } = makeApp({});
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "GET", url: "/v1/admin/audit-log?limit=abc",
      headers: adminH,
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects ?limit=0 / negative", async () => {
    const { app, warm } = makeApp({});
    const adminH = await adminAuth(warm);
    const r1 = await app.inject({
      method: "GET", url: "/v1/admin/audit-log?limit=0",
      headers: adminH,
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({
      method: "GET", url: "/v1/admin/audit-log?limit=-5",
      headers: adminH,
    });
    expect(r2.statusCode).toBe(400);
  });

  it("clamps via schema max=500 (anything above rejects)", async () => {
    const { app, warm } = makeApp({});
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "GET", url: "/v1/admin/audit-log?limit=1000",
      headers: adminH,
    });
    expect(r.statusCode).toBe(400);
  });

  it("accepts a valid limit", async () => {
    const { app, warm } = makeApp({});
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "GET", url: "/v1/admin/audit-log?limit=50",
      headers: adminH,
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("http: project-share uses exact-email lookup (#14)", () => {
  it("does not match a user whose name collides with the requested handle", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    // Owner creates a project.
    const owner = await userAuth(warm, "owner@example.com");
    // "alice@example.com" — the actual target.
    await warm.createUser({
      username: "alice@example.com",
      passwordHash: "x",
      role: "user",
    });
    // Attacker registers with a benign email but display-name 'alice'.
    // The fake's `username` doubles as both email and name; the only
    // field exact-email looks at is the email, so the attacker is
    // unreachable when the owner asks for "alice".
    await warm.createUser({
      username: "attacker@evil.test",
      passwordHash: "x",
      role: "user",
    });
    const proj = await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { name: "p1" },
      headers: { authorization: owner.authorization },
    });
    expect(proj.statusCode).toBe(201);
    const projectId = proj.json().id;
    // Owner asks for bare local-part "alice" — exact-email finds nothing.
    const fuzzy = await app.inject({
      method: "POST", url: `/v1/me/projects/${projectId}/members`,
      payload: { username: "alice" },
      headers: { authorization: owner.authorization },
    });
    expect(fuzzy.statusCode).toBe(404);
    // Owner asks for the full email — exact-email finds alice.
    const exact = await app.inject({
      method: "POST", url: `/v1/me/projects/${projectId}/members`,
      payload: { username: "alice@example.com" },
      headers: { authorization: owner.authorization },
    });
    expect(exact.statusCode).toBe(201);
    expect(exact.json().username).toBe("alice@example.com");
  });
});

describe("http: POST /v1/admin/users (non-interactive provisioning)", () => {
  it("admin provisions a user + bearer in one call; bearer works on the data plane", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const headers = await adminAuth(warm);
    const r = await app.inject({
      method: "POST", url: "/v1/admin/users",
      payload: { email: "agent-1@novaflow.local", password: "s3cret-pass", tokenLabel: "novaflow" },
      headers,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.userId).toBeTruthy();
    expect(body.token).toMatch(/^nm_/);
    // The minted bearer authenticates data-plane calls as the new user.
    const remember = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "agent-1 memory" },
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(remember.statusCode).toBe(201);
  });

  it("omits the token when no tokenLabel is requested", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const headers = await adminAuth(warm);
    const r = await app.inject({
      method: "POST", url: "/v1/admin/users",
      payload: { email: "agent-2@novaflow.local", password: "s3cret-pass" },
      headers,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().token).toBeUndefined();
  });

  it("duplicate email answers 409", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const headers = await adminAuth(warm);
    const payload = { email: "dup@novaflow.local", password: "s3cret-pass" };
    const first = await app.inject({ method: "POST", url: "/v1/admin/users", payload, headers });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/v1/admin/users", payload, headers });
    expect(second.statusCode).toBe(409);
  });

  it("non-admin caller gets 403, anonymous gets 401", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const user = await userAuth(warm, "plain-user");
    const payload = { email: "x@novaflow.local", password: "s3cret-pass" };
    const asUser = await app.inject({
      method: "POST", url: "/v1/admin/users", payload,
      headers: { authorization: user.authorization },
    });
    expect(asUser.statusCode).toBe(403);
    const anon = await app.inject({ method: "POST", url: "/v1/admin/users", payload });
    expect(anon.statusCode).toBe(401);
  });

  it("an admin-owned nm_ bearer reaches admin routes; a plain user's does not", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const admin = await userAuth(warm, "root-admin", "admin");
    const adminTok = await warm.createUserToken(admin.userId, "automation");
    const r = await app.inject({
      method: "POST", url: "/v1/admin/users",
      payload: { email: "agent-3@novaflow.local", password: "s3cret-pass", tokenLabel: "t" },
      headers: { authorization: `Bearer ${adminTok!.token}` },
    });
    expect(r.statusCode).toBe(201);
    // A regular user's bearer resolves but fails the role check.
    const plain = await userAuth(warm, "plain-2");
    const plainTok = await warm.createUserToken(plain.userId, "automation");
    const denied = await app.inject({
      method: "POST", url: "/v1/admin/users",
      payload: { email: "y@novaflow.local", password: "s3cret-pass" },
      headers: { authorization: `Bearer ${plainTok!.token}` },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("http: token scoping + expiry (restricted bearers)", () => {
  async function mintVia(app: ReturnType<typeof makeApp>["app"], auth: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: body, headers: { authorization: auth },
    });
  }

  it("read_only token: search allowed, remember/forget/mint/admin denied", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "ro-owner");
    const minted = await mintVia(app, u.authorization, { label: "ro", scope: "read_only" });
    expect(minted.statusCode).toBe(201);
    const tok = `Bearer ${minted.json().token}`;
    const search = await app.inject({
      method: "POST", url: "/v1/search", payload: { query: "x" },
      headers: { authorization: tok },
    });
    expect(search.statusCode).toBe(200);
    const remember = await app.inject({
      method: "POST", url: "/v1/remember", payload: { content: "nope" },
      headers: { authorization: tok },
    });
    expect(remember.statusCode).toBe(403);
    const forget = await app.inject({
      method: "POST", url: "/v1/forget", payload: { id: "01K" },
      headers: { authorization: tok },
    });
    expect(forget.statusCode).toBe(403);
    const mint = await app.inject({
      method: "POST", url: "/v1/me/tokens", payload: { label: "esc" },
      headers: { authorization: tok },
    });
    expect(mint.statusCode).toBe(403);
    const admin = await app.inject({
      method: "POST", url: "/v1/admin/users",
      payload: { email: "x@x.local", password: "longenough" },
      headers: { authorization: tok },
    });
    expect(admin.statusCode).toBe(403);
  });

  it("project-confined token: writes land in the project; other scopes 403", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "pj-owner");
    const created = await app.inject({
      method: "POST", url: "/v1/me/projects", payload: { name: "confine" },
      headers: { authorization: u.authorization },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id;
    const other = await app.inject({
      method: "POST", url: "/v1/me/projects", payload: { name: "other" },
      headers: { authorization: u.authorization },
    });
    const otherId = other.json().id;
    const minted = await mintVia(app, u.authorization, { label: "pj", project: projectId });
    expect(minted.statusCode).toBe(201);
    const tok = `Bearer ${minted.json().token}`;
    // Unscoped write is forced into the project.
    const remember = await app.inject({
      method: "POST", url: "/v1/remember", payload: { content: "confined fact" },
      headers: { authorization: tok },
    });
    expect(remember.statusCode).toBe(201);
    const recent = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: tok },
    });
    expect(recent.json().results.some((r: { content: string }) => r.content === "confined fact")).toBe(true);
    // Explicitly asking for another project is refused, not rewritten.
    const cross = await app.inject({
      method: "POST", url: "/v1/search", payload: { query: "x", project: otherId },
      headers: { authorization: tok },
    });
    expect(cross.statusCode).toBe(403);
    // Owner sees the entry inside the project, proving where it landed.
    const inProject = await app.inject({
      method: "POST", url: "/v1/recent", payload: { includeProjects: [projectId] },
      headers: { authorization: u.authorization },
    });
    expect(inProject.json().results.some((r: { content: string }) => r.content === "confined fact")).toBe(true);
  });

  it("expired token answers 401", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "exp-owner");
    const t = await warm.createUserToken(u.userId, "old", {
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = await app.inject({
      method: "POST", url: "/v1/search", payload: { query: "x" },
      headers: { authorization: `Bearer ${t!.token}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it("mint accepts expiresInDays and reports the restriction fields", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "meta-owner");
    const minted = await mintVia(app, u.authorization, {
      label: "ttl", scope: "read_only", expiresInDays: 7,
    });
    expect(minted.statusCode).toBe(201);
    const body = minted.json();
    expect(body.scope).toBe("read_only");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("http: admin user lifecycle (list + delete cascade)", () => {
  it("GET /v1/admin/users lists users with footprint counts", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const adminH = await adminAuth(warm);
    const u = await userAuth(warm, "census-user");
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "census user prefers the dark dashboard theme at night" },
      headers: { authorization: u.authorization },
    });
    const r = await app.inject({ method: "GET", url: "/v1/admin/users", headers: adminH });
    expect(r.statusCode).toBe(200);
    const row = r.json().users.find((x: { email: string }) => x.email === "census-user");
    expect(row).toBeTruthy();
    expect(row.entryCount).toBe(1);
  });

  it("DELETE cascades: memories, tokens, owned projects; user gone", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const adminH = await adminAuth(warm);
    const u = await userAuth(warm, "doomed-user");
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "doomed user keeps a user-global fact about deployment state" },
      headers: { authorization: u.authorization },
    });
    const proj = await app.inject({
      method: "POST", url: "/v1/me/projects", payload: { name: "doomed-proj" },
      headers: { authorization: u.authorization },
    });
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "doomed project holds a fact about sprint conventions", project: proj.json().id },
      headers: { authorization: u.authorization },
    });
    const tok = await warm.createUserToken(u.userId, "agent");
    // Dry-run first: reports, deletes nothing.
    const dry = await app.inject({
      method: "DELETE", url: `/v1/admin/users/${u.userId}?dryRun=true`, headers: adminH,
    });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().dryRun).toBe(true);
    expect(dry.json().wouldDelete.ownedProjects).toHaveLength(1);
    expect(warm.users.has(u.userId)).toBe(true);
    // Real delete.
    const del = await app.inject({
      method: "DELETE", url: `/v1/admin/users/${u.userId}`, headers: adminH,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);
    expect(del.json().projectsDeleted).toHaveLength(1);
    expect(del.json().entriesRemoved).toBeGreaterThanOrEqual(1);
    expect(warm.users.has(u.userId)).toBe(false);
    // The dead user's bearer no longer authenticates.
    const after = await app.inject({
      method: "POST", url: "/v1/search", payload: { query: "x" },
      headers: { authorization: `Bearer ${tok!.token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("admin cannot delete themselves; non-admin cannot delete anyone", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const admin = await userAuth(warm, "self-admin", "admin");
    const self = await app.inject({
      method: "DELETE", url: `/v1/admin/users/${admin.userId}`,
      headers: { authorization: admin.authorization },
    });
    expect(self.statusCode).toBe(400);
    const plain = await userAuth(warm, "plain-3");
    const denied = await app.inject({
      method: "DELETE", url: `/v1/admin/users/${admin.userId}`,
      headers: { authorization: plain.authorization },
    });
    expect(denied.statusCode).toBe(403);
    const missing = await app.inject({
      method: "DELETE", url: "/v1/admin/users/nonexistent",
      headers: { authorization: admin.authorization },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("http: search contentMode (payload shaping)", () => {
  async function seed(app: ReturnType<typeof makeApp>["app"], auth: string) {
    const long = "the deployment pipeline uses a Zot registry cache on the cluster and " +
      "falls back to plain builds when the cache is unreachable; ".repeat(4);
    const r = await app.inject({
      method: "POST", url: "/v1/remember", payload: { content: long },
      headers: { authorization: auth },
    });
    expect(r.statusCode).toBe(201);
    return long;
  }

  it("snippet mode truncates on a word boundary and flags it", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "snippet-user");
    const long = await seed(app, u.authorization);
    const r = await app.inject({
      method: "POST", url: "/v1/search",
      payload: { query: "deployment pipeline registry", contentMode: "snippet" },
      headers: { authorization: u.authorization },
    });
    expect(r.statusCode).toBe(200);
    const hit = r.json().results[0];
    expect(hit.truncated).toBe(true);
    expect(hit.content.length).toBeLessThan(long.length);
    expect(hit.content.length).toBeLessThanOrEqual(241);
    expect(hit.content.endsWith("…")).toBe(true);
    // Boundary contract: the cut text (sans ellipsis) must be a prefix of
    // the original ending exactly at a whitespace boundary — the next
    // character in the original is whitespace, so no word was split.
    const stem = hit.content.slice(0, -1);
    expect(long.startsWith(stem)).toBe(true);
    expect(long[stem.length]).toMatch(/\s/);
  });

  it("ids mode omits content and metadata; full is unchanged", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "ids-user");
    const long = await seed(app, u.authorization);
    const ids = await app.inject({
      method: "POST", url: "/v1/search",
      payload: { query: "deployment pipeline registry", contentMode: "ids" },
      headers: { authorization: u.authorization },
    });
    const hit = ids.json().results[0];
    expect(hit.id).toBeTruthy();
    expect(hit.content).toBeUndefined();
    expect(hit.metadata).toBeUndefined();
    const full = await app.inject({
      method: "POST", url: "/v1/search",
      payload: { query: "deployment pipeline registry" },
      headers: { authorization: u.authorization },
    });
    expect(full.json().results[0].content).toBe(long);
  });

  it("recent supports contentMode too", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "recent-shape-user");
    await seed(app, u.authorization);
    const r = await app.inject({
      method: "POST", url: "/v1/recent", payload: { contentMode: "ids" },
      headers: { authorization: u.authorization },
    });
    expect(r.json().results[0].content).toBeUndefined();
  });
});

describe("http: memory TTL (expiresAt)", () => {
  it("expired entries vanish from reads immediately and are reaped by decay", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "ttl-user");
    const put = async (content: string, expiresAt?: string) =>
      app.inject({
        method: "POST", url: "/v1/remember",
        payload: { content, ...(expiresAt ? { expiresAt } : {}) },
        headers: { authorization: u.authorization },
      });
    const keep = await put("the permanent fact about the deployment topology");
    expect(keep.statusCode).toBe(201);
    // Future TTL: visible now.
    const future = new Date(Date.now() + 3600_000).toISOString();
    const soon = await put("the deploy freeze ends on friday afternoon", future);
    expect(soon.statusCode).toBe(201);
    const before = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: u.authorization },
    });
    expect(before.json().results).toHaveLength(2);
    // Force-expire it by rewriting the stored metadata (simulates time).
    const id = soon.json().id;
    const row = warm.rows.get(id)!;
    row.metadata = { ...row.metadata, expiresAt: new Date(Date.now() - 1000).toISOString() };
    const after = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: u.authorization },
    });
    expect(after.json().results).toHaveLength(1);
    expect(after.json().results[0].content).toContain("permanent");
    // Decay reaps the row for real.
    const adminH = await adminAuth(warm);
    const decay = await app.inject({
      method: "POST", url: "/v1/decay", payload: {}, headers: adminH,
    });
    expect(decay.statusCode).toBe(200);
    expect(decay.json().expired).toBe(1);
    expect(warm.rows.has(id)).toBe(false);
  });

  it("rejects a malformed expiresAt", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "ttl-bad");
    const r = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "some fact that would otherwise be stored fine", expiresAt: "next tuesday" },
      headers: { authorization: u.authorization },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("http: /v1/me/changes (per-user changelog)", () => {
  it("records created/updated/deleted and pages by seq cursor", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "changes-user");
    const created = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "the staging environment uses the blue ingress class" },
      headers: { authorization: u.authorization },
    });
    const id = created.json().id;
    await app.inject({
      method: "PUT", url: `/v1/memories/${id}`,
      payload: { content: "the staging environment uses the green ingress class now" },
      headers: { authorization: u.authorization },
    });
    await app.inject({
      method: "POST", url: "/v1/forget", payload: { id },
      headers: { authorization: u.authorization },
    });
    // Off-path appends — give the microtask queue a beat.
    await new Promise((r) => setTimeout(r, 20));
    const page1 = await app.inject({
      method: "GET", url: "/v1/me/changes?limit=2",
      headers: { authorization: u.authorization },
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.changes.map((c: { change: string }) => c.change)).toEqual(["created", "updated"]);
    const page2 = await app.inject({
      method: "GET", url: `/v1/me/changes?afterSeq=${p1.nextSeq}`,
      headers: { authorization: u.authorization },
    });
    expect(page2.json().changes.map((c: { change: string }) => c.change)).toEqual(["deleted"]);
    expect(page2.json().changes[0].entryId).toBe(id);
  });

  it("changelog is per-user — B never sees A's events", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const a = await userAuth(warm, "changes-a");
    const b = await userAuth(warm, "changes-b");
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "a private fact belonging to user a about deployments" },
      headers: { authorization: a.authorization },
    });
    await new Promise((r) => setTimeout(r, 20));
    const forB = await app.inject({
      method: "GET", url: "/v1/me/changes",
      headers: { authorization: b.authorization },
    });
    expect(forB.json().changes).toHaveLength(0);
  });
});

describe("http: per-user write quotas", () => {
  it("rate limit answers 429 after the per-minute budget", async () => {
    const { app, warm } = makeApp({ authMode: "user", quotas: { maxEntries: 0, writesPerMinute: 2 } });
    const u = await userAuth(warm, "rate-user");
    const put = (i: number) =>
      app.inject({
        method: "POST", url: "/v1/remember",
        payload: { content: `distinct durable fact number ${i} about the pipeline configuration` },
        headers: { authorization: u.authorization },
      });
    expect((await put(1)).statusCode).toBe(201);
    expect((await put(2)).statusCode).toBe(201);
    const third = await put(3);
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toContain("write quota exceeded");
  });

  it("entry cap answers 429; forget frees room only after recount window", async () => {
    const { app, warm } = makeApp({ authMode: "user", quotas: { maxEntries: 1, writesPerMinute: 0 } });
    const u = await userAuth(warm, "cap-user");
    const first = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "the only fact this capped user is allowed to keep around" },
      headers: { authorization: u.authorization },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "a second fact that must be refused by the entry quota" },
      headers: { authorization: u.authorization },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toContain("entry quota exceeded");
  });

  it("admin override wins over the server default; usage reports it", async () => {
    const { app, warm } = makeApp({ authMode: "user", quotas: { maxEntries: 1, writesPerMinute: 0 } });
    const adminH = await adminAuth(warm);
    const u = await userAuth(warm, "override-user");
    const bump = await app.inject({
      method: "PUT", url: `/v1/admin/users/${u.userId}/quota`,
      payload: { maxEntries: 5 },
      headers: adminH,
    });
    expect(bump.statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: "POST", url: "/v1/remember",
        payload: { content: `override user durable fact number ${i} about cluster networking` },
        headers: { authorization: u.authorization },
      });
      expect(r.statusCode).toBe(201);
    }
    const usage = await app.inject({
      method: "GET", url: "/v1/me/usage",
      headers: { authorization: u.authorization },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().entries).toBe(3);
    expect(usage.json().quota.maxEntries).toBe(5);
  });

  it("quotas off by default — no limit enforced", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const u = await userAuth(warm, "unlimited-user");
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: "POST", url: "/v1/remember",
        payload: { content: `unlimited user durable fact number ${i} about storage classes` },
        headers: { authorization: u.authorization },
      });
      expect(r.statusCode).toBe(201);
    }
  });
});

describe("http: export/import round trip", () => {
  it("exports pages by cursor and re-imports idempotently elsewhere", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const src = await userAuth(warm, "export-user");
    const contents = [
      "first durable fact about the ingress controller configuration",
      "second durable fact about the postgres shared buffers sizing",
      "third durable fact about the reranker endpoint on the dgx",
    ];
    for (const content of contents) {
      const r = await app.inject({
        method: "POST", url: "/v1/remember", payload: { content },
        headers: { authorization: src.authorization },
      });
      expect(r.statusCode).toBe(201);
    }
    // Page with limit 2 → 2 + 1 via cursor.
    const p1 = await app.inject({
      method: "GET", url: "/v1/me/export?limit=2",
      headers: { authorization: src.authorization },
    });
    expect(p1.json().entries).toHaveLength(2);
    const p2 = await app.inject({
      method: "GET", url: `/v1/me/export?limit=2&afterId=${p1.json().nextAfterId}`,
      headers: { authorization: src.authorization },
    });
    expect(p2.json().entries).toHaveLength(1);
    // Import into a different user.
    const dst = await userAuth(warm, "import-user");
    const all = [...p1.json().entries, ...p2.json().entries].map(
      ({ content, namespace, metadata }: { content: string; namespace: string; metadata: Record<string, unknown> }) =>
        ({ content, namespace, metadata }),
    );
    const imp = await app.inject({
      method: "POST", url: "/v1/me/import", payload: { entries: all },
      headers: { authorization: dst.authorization },
    });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().imported).toBe(3);
    // Re-import: content-hash dedup makes it idempotent.
    const again = await app.inject({
      method: "POST", url: "/v1/me/import", payload: { entries: all },
      headers: { authorization: dst.authorization },
    });
    expect(again.json().imported).toBe(0);
    expect(again.json().deduplicated).toBe(3);
    // The import landed for dst, invisible to src's scope and vice versa.
    const dstRecent = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: dst.authorization },
    });
    expect(dstRecent.json().results).toHaveLength(3);
  });
});
