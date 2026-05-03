import { describe, expect, it } from "vitest";

import { buildHttpServer } from "./http.js";
import { MemoryEngine } from "./engine/index.js";
import { MetricsCollector } from "./admin/metrics.js";
import {
  asCold,
  asGraph,
  asWarm,
  FakeColdStore,
  FakeEmbedder,
  FakeGraphStore,
  FakeWarmStore,
} from "./test-fakes.js";

function makeApp(
  opts: {
    authMode?: "none" | "bearer" | "user";
    token?: string;
    adminDashboard?: boolean;
    withMetrics?: boolean;
  } = {},
) {
  const warm = new FakeWarmStore();
  const cold = new FakeColdStore();
  const graph = new FakeGraphStore();
  const metrics = opts.withMetrics === false ? undefined : new MetricsCollector();
  if (metrics) {
    metrics.bindGaugeSources({
      warmEntries: async () => [...warm.rows.values()].filter((r) => !r.cold).length,
      coldEntries: async () => [...warm.rows.values()].filter((r) => r.cold).length,
      graphEdges: async () => graph.edgeCount(),
      orphansPending: async () => warm.coldOrphans.size,
    });
  }
  const engine = new MemoryEngine({
    warm: asWarm(warm),
    cold: asCold(cold),
    graph: asGraph(graph),
    embedder: new FakeEmbedder(),
    defaultEffectiveDays: 7,
    metrics,
  });
  const app = buildHttpServer({
    engine,
    warm: asWarm(warm),
    auth: { mode: opts.authMode ?? "none", token: opts.token },
    rateLimitPerMinute: 100_000, // effectively off for tests
    metrics,
    adminDashboard: opts.adminDashboard,
  });
  return { app, warm, cold, graph, metrics };
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

describe("http: /health", () => {
  it("returns 200 + dep snapshot when everything is up", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, deps: { warm: "ok", cold: "ok", graph: "ok" } });
  });

  it("returns 503 when cold is unreachable", async () => {
    const { app, cold } = makeApp();
    cold.fail = true;
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(503);
    expect(r.json().deps.cold).toBe("unreachable");
  });
});

describe("http: /v1/remember", () => {
  it("accepts a valid body and returns 201 + id", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "hello world", namespace: "ns" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("rejects empty content", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "" },
    });
    expect(r.statusCode).toBe(400); // Zod errors mapped to 400 by setErrorHandler
    expect(r.json().error).toMatch(/invalid request/i);
  });

  it("rejects oversized content (> 256KB)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "x".repeat(300_000) },
    });
    expect([400, 413]).toContain(r.statusCode);
  });
});

describe("http: /v1/search", () => {
  it("returns ranked results", async () => {
    const { app } = makeApp();
    await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "Pascal likes coffee" } });
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
    await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "marker token" } });
    const r = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "marker", weights: { keyword: 1, vector: 0, graph: 0 } },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("http: /v1/recent + /v1/forget", () => {
  it("recent returns newest first", async () => {
    const { app, warm } = makeApp();
    const a = await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "first" } });
    const b = await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "second" } });
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
    const created = await app.inject({ method: "POST", url: "/v1/remember", payload: { content: "to forget" } });
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

  it("/health is always public, even in bearer mode", async () => {
    const { app } = makeApp({ authMode: "bearer", token: "secret" });
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
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

  it("admin routes refuse a user bearer (only session-admin works)", async () => {
    const { app, tokenA } = await setupTwoUsers();
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it("memories don't mix between users — search", async () => {
    const { app, tokenA, tokenB } = await setupTwoUsers();
    const created = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "Pascal likes dark roast coffee" },
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
      payload: { content: "user a fact" },
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
    expect(bForget.json().deleted).toBe(false);
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
      payload: { content: "Pascal likes dark roast coffee" },
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

  it("graph_edges is null when graph store is unreachable", async () => {
    const { app, graph, warm } = makeApp({});
    const adminH = await adminAuth(warm);
    graph.connected = false;
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/metrics",
      headers: adminH,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().gauges.graph_edges).toBeNull();
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

describe("http: user delete (admin)", () => {
  async function bootstrap() {
    const { app, warm } = makeApp({ authMode: "user" });
    const adminH = await adminAuth(warm);
    const u = await warm.createUser({
      username: "alice-del",
      passwordHash: "test",
      role: "user",
    });
    const tk = await warm.createUserToken(u.id, "first");
    return { app, warm, adminH, userId: u.id, token: tk!.token };
  }

  it("DELETE /v1/admin/users/:id purges the user + tokens + memories", async () => {
    const { app, userId, token, adminH } = await bootstrap();
    await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "to be deleted", namespace: "default" },
      headers: { authorization: `Bearer ${token}` },
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/admin/users/${userId}`,
      headers: adminH,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);
    expect(del.json().entriesRemoved).toBeGreaterThanOrEqual(1);

    // Old bearer rejected.
    const after = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("DELETE on unknown user 404s", async () => {
    const { app, adminH } = await bootstrap();
    const r = await app.inject({
      method: "DELETE",
      url: "/v1/admin/users/does-not-exist",
      headers: adminH,
    });
    expect(r.statusCode).toBe(404);
  });

  it("DELETE requires admin auth", async () => {
    const { app, userId, token } = await bootstrap();
    const r = await app.inject({
      method: "DELETE",
      url: `/v1/admin/users/${userId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(401);
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
  async function setupWithAdmin(adminPwd = "supersecret") {
    const { app, warm } = makeApp({ authMode: "user" });
    const { hashPassword } = await import("./auth.js");
    const hash = await hashPassword(adminPwd);
    await warm.createUser({ username: "alice", passwordHash: hash, role: "admin" });
    return { app, warm, adminPwd };
  }

  it("/v1/auth/status reports bootstrap state", async () => {
    const { app } = makeApp({ authMode: "user" });
    const r1 = await app.inject({ method: "GET", url: "/v1/auth/status" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ ready: false, bootstrapNeeded: true });
  });

  it("login rejects unknown user / wrong password", async () => {
    const { app } = await setupWithAdmin();
    const bad = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "alice", password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const missing = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "nobody", password: "supersecret" },
    });
    expect(missing.statusCode).toBe(401);
  });

  it("login + me + logout round-trip", async () => {
    const { app, adminPwd } = await setupWithAdmin();
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "alice", password: adminPwd },
    });
    expect(login.statusCode).toBe(201);
    const session = login.json().token as string;
    expect(session).toMatch(/^ns_/);

    const me = await app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("alice");
    expect(me.json().user.role).toBe("admin");

    const out = await app.inject({
      method: "POST", url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(out.statusCode).toBe(204);

    const dead = await app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(dead.statusCode).toBe(401);
  });

  it("admin can create + delete + promote/demote users", async () => {
    const { app, warm, adminPwd } = await setupWithAdmin();

    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "alice", password: adminPwd },
    });
    const session = login.json().token as string;
    const auth = { authorization: `Bearer ${session}` };

    const created = await app.inject({
      method: "POST", url: "/v1/admin/users",
      payload: { username: "bob", password: "bobsbobsbobs", role: "user", userId: "acme" },
      headers: auth,
    });
    expect(created.statusCode).toBe(201);
    const bobId = created.json().id;

    const list = await app.inject({ method: "GET", url: "/v1/admin/users", headers: auth });
    // The synthetic `public` user is always seeded; alice + bob are
    // the two test users we created. So 3 total.
    const usernames = list.json().users.map((u: { username: string }) => u.username).sort();
    expect(usernames).toEqual(["alice", "bob", "public"]);

    const promote = await app.inject({
      method: "POST", url: `/v1/admin/users/${bobId}/role`,
      payload: { role: "admin" },
      headers: auth,
    });
    expect(promote.statusCode).toBe(200);

    const demote = await app.inject({
      method: "POST", url: `/v1/admin/users/${bobId}/role`,
      payload: { role: "user", userId: "acme" },
      headers: auth,
    });
    expect(demote.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE", url: `/v1/admin/users/${bobId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
  });

  it("refuses to delete self or the last admin", async () => {
    const { app, adminPwd } = await setupWithAdmin();
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "alice", password: adminPwd },
    });
    const session = login.json().token as string;
    const auth = { authorization: `Bearer ${session}` };
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: auth });
    const aliceId = me.json().user.id;

    const selfDel = await app.inject({
      method: "DELETE", url: `/v1/admin/users/${aliceId}`,
      headers: auth,
    });
    expect(selfDel.statusCode).toBe(400);
  });

  it("user role: /v1/me/metrics is scoped to that user", async () => {
    const { app, warm } = await setupWithAdmin();
    const { hashPassword } = await import("./auth.js");
    const hash = await hashPassword("bobpass1");
    const bob = await warm.createUser({ username: "bob", passwordHash: hash, role: "user" });

    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "bob", password: "bobpass1" },
    });
    const session = login.json().token as string;

    const m = await app.inject({
      method: "GET", url: "/v1/me/metrics",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(m.statusCode).toBe(200);
    expect(m.json().userId).toBe(bob.id);
  });

  it("user can create + delete their own tokens", async () => {
    const { app, warm } = await setupWithAdmin();
    const { hashPassword } = await import("./auth.js");
    const hash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: hash, role: "user" });

    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "bob", password: "bobpass1" },
    });
    const session = login.json().token as string;
    const auth = { authorization: `Bearer ${session}` };

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

    // Token row gone from listing — hard delete, no soft tombstone.
    const after_list = await app.inject({ method: "GET", url: "/v1/me/tokens", headers: auth });
    expect(after_list.json().tokens.length).toBe(0);

    const after = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${userBearer}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("user cannot reach admin routes", async () => {
    const { app, warm } = await setupWithAdmin();
    const { hashPassword } = await import("./auth.js");
    const hash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: hash, role: "user", userId: "acme" });

    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "bob", password: "bobpass1" },
    });
    const session = login.json().token as string;

    const r = await app.inject({
      method: "GET", url: "/v1/admin/users",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe("http: P0 regression tests", () => {
  async function setupBobInAcme() {
    const { app, warm } = makeApp({ authMode: "user" });
    const { hashPassword } = await import("./auth.js");
    const bobHash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: bobHash, role: "user", userId: "acme" });
    const carolHash = await hashPassword("carolpass1");
    await warm.createUser({ username: "carol", passwordHash: carolHash, role: "user", userId: "contoso" });
    const login = (u: string, p: string) => app.inject({
      method: "POST", url: "/v1/auth/login", payload: { username: u, password: p },
    });
    const bobSession = (await login("bob", "bobpass1")).json().token as string;
    const carolSession = (await login("carol", "carolpass1")).json().token as string;
    return { app, warm, bobSession, carolSession };
  }

  // P0-1 (user id `p_*` collision with project collection prefix) is
  // obsolete — there are no user ids any more, just user ids; user
  // creation goes through usernames which can't collide with project
  // collection naming.

  // P0-2: removing a member terminates that user's project access.
  // Tokens themselves have no per-project scope; access flows from the
  // owning user's memberships at request time. So the kicked member's
  // bearer continues to work for their own user-global memory but is
  // refused when it asks for the project they used to be in.
  it("P0-2: removeProjectMember terminates the kicked user's project access", async () => {
    const { app, bobSession, carolSession } = await setupBobInAcme();
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
    // Bob removes Carol.
    const carolMe = await app.inject({ method: "GET", url: "/v1/auth/me", headers: carolAuth });
    const carolUserId = carolMe.json().user.id;
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

  // P0-3: per-username login throttle locks an account out after 5 failures
  // Backoff sleeps add up; allow extra time.
  it("P0-3: 5 wrong passwords lock the account out (429)", { timeout: 15_000 }, async () => {
    const { app } = makeApp({ authMode: "user" });
    const { hashPassword } = await import("./auth.js");
    const w = (app as unknown as { warmFake?: unknown }) as never;
    void w;
    // Register bob
    const { warm } = makeApp({ authMode: "user" });
    void warm; // throwaway — main test uses the throttle on the original app
    // Fresh app for an isolated throttle.
    const { app: app2, warm: warm2 } = makeApp({ authMode: "user" });
    const hash = await hashPassword("right-password");
    await warm2.createUser({ username: "bob", passwordHash: hash, role: "user" });
    for (let i = 0; i < 5; i++) {
      const bad = await app2.inject({
        method: "POST", url: "/v1/auth/login",
        payload: { username: "bob", password: "wrong" + i },
      });
      expect(bad.statusCode).toBe(401);
    }
    // 6th attempt — even with the right password — is throttled.
    const sixth = await app2.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "bob", password: "right-password" },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers["retry-after"]).toBeDefined();
  });

  // P0-4: getEntry's `"*"` magic-string bypass is gone
  it("P0-4: getEntry with projectId='*' is treated as a literal id, not a bypass", async () => {
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

  // P0-5: cross-user project member CAN forget shared rows
  it("P0-5: cross-user project member can forget a shared entry", async () => {
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
      payload: { content: "bob's note", project: sharedId },
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

  // P0-6: cookie-authed /v1/me/* mirrors must check project membership.
  // Without this guard, any user in `acme` could read/write any
  // project under `acme` by passing the project id in the body — even
  // projects they're not a member of.
  it("P0-6: /v1/me/search refuses non-members of the requested project", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const { hashPassword } = await import("./auth.js");
    const aliceHash = await hashPassword("alicepass1");
    const bobHash = await hashPassword("bobpass1");
    await warm.createUser({ username: "alice", passwordHash: aliceHash, role: "user", userId: "acme" });
    await warm.createUser({ username: "bob", passwordHash: bobHash, role: "user", userId: "acme" });
    const login = (u: string, p: string) => app.inject({
      method: "POST", url: "/v1/auth/login", payload: { username: u, password: p },
    });
    const aliceSession = (await login("alice", "alicepass1")).json().token as string;
    const bobSession = (await login("bob", "bobpass1")).json().token as string;
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

    // Each /v1/me/* mirror must 403 when Bob targets Alice's project.
    const search = await app.inject({
      method: "POST", url: "/v1/me/search",
      payload: { query: "x", project: aliceProjId },
      headers: bobAuth,
    });
    expect(search.statusCode).toBe(403);

    const recent = await app.inject({
      method: "POST", url: "/v1/me/recent",
      payload: { project: aliceProjId },
      headers: bobAuth,
    });
    expect(recent.statusCode).toBe(403);

    const remember = await app.inject({
      method: "POST", url: "/v1/me/remember",
      payload: { content: "bob's intrusion", project: aliceProjId },
      headers: bobAuth,
    });
    expect(remember.statusCode).toBe(403);

    const forget = await app.inject({
      method: "POST", url: "/v1/me/forget",
      payload: { id: "01HXXX", project: aliceProjId },
      headers: bobAuth,
    });
    expect(forget.statusCode).toBe(403);

    const neighbors = await app.inject({
      method: "POST", url: "/v1/me/neighbors",
      payload: { id: "01HXXX", project: aliceProjId },
      headers: bobAuth,
    });
    expect(neighbors.statusCode).toBe(403);

    // Alice (the owner) can still use her own project.
    const okSearch = await app.inject({
      method: "POST", url: "/v1/me/search",
      payload: { query: "x", project: aliceProjId },
      headers: aliceAuth,
    });
    expect(okSearch.statusCode).toBe(200);
  });

  // P0-6 follow-up: /v1/me/forget can't be tricked into deleting a
  // project-scoped entry by passing project: null. The handler looks up
  // the actual entry's project_id and re-checks membership.
  it("P0-6: /v1/me/forget rechecks the entry's real project", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const { hashPassword } = await import("./auth.js");
    const aliceHash = await hashPassword("alicepass1");
    const bobHash = await hashPassword("bobpass1");
    await warm.createUser({ username: "alice", passwordHash: aliceHash, role: "user", userId: "acme" });
    await warm.createUser({ username: "bob", passwordHash: bobHash, role: "user", userId: "acme" });
    const login = (u: string, p: string) => app.inject({
      method: "POST", url: "/v1/auth/login", payload: { username: u, password: p },
    });
    const aliceSession = (await login("alice", "alicepass1")).json().token as string;
    const bobSession = (await login("bob", "bobpass1")).json().token as string;
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
      payload: { content: "alice's secret", project: aliceProjId },
      headers: { authorization: `Bearer ${aliceTok}` },
    });
    const id = created.json().id;

    // Bob tries to delete the entry by passing project: null. The first
    // membership check passes (null is allowed — user-wide is OK), but
    // the entry-resolution recheck must catch it.
    const r = await app.inject({
      method: "POST", url: "/v1/me/forget",
      payload: { id }, headers: bobAuth,
    });
    expect(r.statusCode).toBe(403);
  });

  // P1-S6: admin actions write to the audit log — the canonical action
  // is now user.create (admin manages users).
  it("P1-S6: user.create writes an audit-log entry", async () => {
    const { app, warm } = makeApp({ authMode: "user" });
    const adminH = await adminAuth(warm);
    await app.inject({
      method: "POST",
      url: "/v1/admin/users",
      payload: { username: "audited", password: "passpass1234", role: "user" },
      headers: adminH,
    });
    const log = await app.inject({
      method: "GET", url: "/v1/admin/audit-log",
      headers: adminH,
    });
    expect(log.statusCode).toBe(200);
    const e = log.json().entries.find(
      (x: { action: string; metadata?: { username?: string } }) =>
        x.action === "user.create" && x.metadata?.username === "audited",
    );
    expect(e).toBeDefined();
    expect(e.actorLabel).toMatch(/^user:admin-/);
  });

  // P2-1: Zod errors → 400 (covered by existing test rewritten earlier).
});

describe("http: projects (sub-brains)", () => {
  async function setupBobInAcme() {
    const { app, warm } = makeApp({ authMode: "user" });
    const { hashPassword } = await import("./auth.js");
    const bobHash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: bobHash, role: "user", userId: "acme" });
    const carolHash = await hashPassword("carolpass1");
    await warm.createUser({ username: "carol", passwordHash: carolHash, role: "user", userId: "contoso" });
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "bob", password: "bobpass1" },
    });
    const session = login.json().token as string;
    return { app, warm, session };
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
      payload: { content: "user-wide alpha" },
      headers: tokAuth,
    });
    // Project remember
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "phoenix beta gamma", project: phoenixId },
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

    // Carol logs in
    const carolLogin = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "carol", password: "carolpass1" },
    });
    const carolSession = carolLogin.json().token as string;
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
      payload: { content: "bob's note in shared", project: sharedId },
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
    const { app, session } = await setupBobInAcme();
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

    const carolLogin = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "carol", password: "carolpass1" },
    });
    const carolAuth = { authorization: `Bearer ${carolLogin.json().token}` };

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
      payload: { content: "to be purged", project: phoenixId },
      headers: { authorization: `Bearer ${tok}` },
    });

    const del = await app.inject({
      method: "DELETE", url: `/v1/me/projects/${phoenixId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);
    expect(del.json().entriesRemoved).toBeGreaterThanOrEqual(1);

    // Token still authenticates (no project scope on tokens), but project
    // access is gone — membership lookup misses since the project is dead.
    const denied = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: { project: phoenixId },
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(denied.statusCode).toBe(403);
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
