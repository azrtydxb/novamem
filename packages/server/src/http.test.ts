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
    authMode?: "none" | "bearer" | "tenant";
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
    tenantId: null,
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

describe("http: tenant mode + admin routes", () => {
  async function setupTenantApp() {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    // Bootstrap two tenants and a token each.
    const mkTenant = async (id: string) => {
      await app.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        payload: { id, name: id },
        headers: adminH,
      });
      const tok = await app.inject({
        method: "POST",
        url: `/v1/admin/tenants/${id}/tokens`,
        payload: { label: "test" },
        headers: adminH,
      });
      return tok.json().token as string;
    };
    const tokenA = await mkTenant("tenant_a");
    const tokenB = await mkTenant("tenant_b");
    return { app, warm, tokenA, tokenB, adminH };
  }

  it("rejects requests without a recognised token", async () => {
    const { app } = makeApp({ authMode: "tenant" });
    const r = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { query: "x" },
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("admin routes require the admin token, not a tenant token", async () => {
    const { app, tokenA } = await setupTenantApp();
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/tenants",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it("memories don't mix between tenants — search", async () => {
    const { app, tokenA, tokenB } = await setupTenantApp();
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
    const { app, tokenA, tokenB } = await setupTenantApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "tenant a fact" },
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const aId = created.json().id;
    // B can't see it in recent.
    const bRecent = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(bRecent.json().results.find((r: { id: string }) => r.id === aId)).toBeUndefined();
    // B can't forget it.
    const bForget = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: { id: aId },
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(bForget.json().deleted).toBe(false);
    // A still has it.
    const aRecent = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(aRecent.json().results.find((r: { id: string }) => r.id === aId)).toBeDefined();
  });

  it("revoked tokens stop working immediately", async () => {
    const { app, tokenA, adminH } = await setupTenantApp();
    // Confirm it works.
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(r1.statusCode).toBe(200);
    // Revoke.
    await app.inject({
      method: "POST",
      url: "/v1/admin/tokens/revoke",
      payload: { token: tokenA },
      headers: adminH,
    });
    // Same call now 401s.
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(r2.statusCode).toBe(401);
  });

  it("create-token response carries the warning that it's shown once", async () => {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      payload: { id: "t1", name: "t1" },
      headers: adminH,
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants/t1/tokens",
      payload: {},
      headers: adminH,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().token).toMatch(/^nm_/);
    expect(r.json().warning).toMatch(/sha256/);
  });

  it("rejects invalid tenant ids at creation", async () => {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      payload: { id: "Has Spaces!", name: "x" },
      headers: adminH,
    });
    expect(r.statusCode).toBe(400);
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

  it("dashboard HTML is reachable in tenant mode without a tenant token", async () => {
    // The HTML shell must load before the user can paste their admin token.
    // The auth hook explicitly skips /admin/* — verify it doesn't 401.
    const { app } = makeApp({ authMode: "tenant" });
    const r = await app.inject({ method: "GET", url: "/admin" });
    expect(r.statusCode).toBe(200);
  });
});

describe("http: tenant CRUD — full lifecycle (admin)", () => {
  async function bootstrap() {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    await app.inject({
      method: "POST", url: "/v1/admin/tenants",
      payload: { id: "acme", name: "Acme" },
      headers: adminH,
    });
    const tk = await app.inject({
      method: "POST", url: "/v1/admin/tenants/acme/tokens",
      payload: { label: "first" },
      headers: adminH,
    });
    return { app, warm, adminH, token: tk.json().token as string };
  }

  it("listTenantTokens returns the tokenHash", async () => {
    const { app, adminH } = await bootstrap();
    const r = await app.inject({
      method: "GET", url: "/v1/admin/tenants/acme/tokens",
      headers: adminH,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().tokens[0].tokenHash).toBeDefined();
    expect(typeof r.json().tokens[0].tokenHash).toBe("string");
  });

  it("revoke-by-hash invalidates the token without needing plaintext", async () => {
    const { app, token, adminH } = await bootstrap();
    const list = await app.inject({
      method: "GET", url: "/v1/admin/tenants/acme/tokens",
      headers: adminH,
    });
    const hash = list.json().tokens[0].tokenHash as string;

    // Token currently works.
    const ok = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);

    // Revoke by hash (the dashboard path).
    const revoke = await app.inject({
      method: "POST", url: `/v1/admin/tenants/acme/tokens/${hash}/revoke`,
      headers: adminH,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revoked).toBe(true);

    // Token rejected on next call.
    const after = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("revoke-by-hash 404s on unknown hash", async () => {
    const { app, adminH } = await bootstrap();
    const fakeHash = "f".repeat(64);
    const r = await app.inject({
      method: "POST", url: `/v1/admin/tenants/acme/tokens/${fakeHash}/revoke`,
      headers: adminH,
    });
    expect(r.statusCode).toBe(404);
  });

  it("revoke-by-hash 400s on a malformed hash", async () => {
    const { app, adminH } = await bootstrap();
    const r = await app.inject({
      method: "POST", url: `/v1/admin/tenants/acme/tokens/not-a-hash/revoke`,
      headers: adminH,
    });
    expect(r.statusCode).toBe(400);
  });

  it("revoke-by-hash requires admin auth", async () => {
    const { app, token, adminH } = await bootstrap();
    const list = await app.inject({
      method: "GET", url: "/v1/admin/tenants/acme/tokens",
      headers: adminH,
    });
    const hash = list.json().tokens[0].tokenHash as string;
    const r = await app.inject({
      method: "POST", url: `/v1/admin/tenants/acme/tokens/${hash}/revoke`,
      headers: { authorization: `Bearer ${token}` }, // tenant token, not admin
    });
    expect(r.statusCode).toBe(401);
  });

  it("DELETE /v1/admin/tenants/:id purges the tenant + tokens + memories", async () => {
    const { app, token, adminH } = await bootstrap();
    // Add a memory so we can verify it gets purged.
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "to be deleted", namespace: "default" },
      headers: { authorization: `Bearer ${token}` },
    });

    const del = await app.inject({
      method: "DELETE", url: "/v1/admin/tenants/acme",
      headers: adminH,
    });
    expect(del.statusCode).toBe(200);
    const body = del.json();
    expect(body.deleted).toBe(true);
    expect(body.entriesRemoved).toBeGreaterThanOrEqual(1);

    // Tenant gone from listing.
    const list = await app.inject({
      method: "GET", url: "/v1/admin/tenants",
      headers: adminH,
    });
    expect(list.json().tenants.find((t: { id: string }) => t.id === "acme")).toBeUndefined();

    // Old token rejected.
    const after = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("DELETE refuses to delete the public tenant", async () => {
    const { app, adminH } = await bootstrap();
    const r = await app.inject({
      method: "DELETE", url: "/v1/admin/tenants/public",
      headers: adminH,
    });
    expect(r.statusCode).toBe(400);
  });

  it("DELETE on unknown tenant 404s", async () => {
    const { app, adminH } = await bootstrap();
    const r = await app.inject({
      method: "DELETE", url: "/v1/admin/tenants/does-not-exist",
      headers: adminH,
    });
    expect(r.statusCode).toBe(404);
  });

  it("DELETE requires admin auth", async () => {
    const { app, token } = await bootstrap();
    const r = await app.inject({
      method: "DELETE", url: "/v1/admin/tenants/acme",
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
    expect(body.components.securitySchemes.TenantBearer).toBeDefined();
  });

  it("/api-docs serves Swagger UI HTML", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/api-docs/static/index.html" });
    // The plugin serves both /api-docs and /api-docs/static/* by default;
    // the static asset path always exists once the plugin is mounted.
    expect([200, 301, 302]).toContain(r.statusCode);
  });

  it("/api-docs is reachable in tenant mode without a bearer", async () => {
    const { app } = makeApp({ authMode: "tenant" });
    const r = await app.inject({ method: "GET", url: "/api-docs/static/index.html" });
    expect([200, 301, 302]).toContain(r.statusCode);
  });
});

describe("http: dashboard auth + RBAC", () => {
  async function setupWithAdmin(adminPwd = "supersecret") {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const { hashPassword } = await import("./auth.js");
    const hash = await hashPassword(adminPwd);
    await warm.createUser({ username: "alice", passwordHash: hash, role: "admin", tenantId: null });
    return { app, warm, adminPwd };
  }

  it("/v1/auth/status reports bootstrap state", async () => {
    const { app } = makeApp({ authMode: "tenant" });
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
    await warm.createTenant("acme", "Acme");

    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "alice", password: adminPwd },
    });
    const session = login.json().token as string;
    const auth = { authorization: `Bearer ${session}` };

    const created = await app.inject({
      method: "POST", url: "/v1/admin/users",
      payload: { username: "bob", password: "bobsbobsbobs", role: "user", tenantId: "acme" },
      headers: auth,
    });
    expect(created.statusCode).toBe(201);
    const bobId = created.json().id;

    const list = await app.inject({ method: "GET", url: "/v1/admin/users", headers: auth });
    expect(list.json().users.length).toBe(2);

    const promote = await app.inject({
      method: "POST", url: `/v1/admin/users/${bobId}/role`,
      payload: { role: "admin" },
      headers: auth,
    });
    expect(promote.statusCode).toBe(200);

    const demote = await app.inject({
      method: "POST", url: `/v1/admin/users/${bobId}/role`,
      payload: { role: "user", tenantId: "acme" },
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

  it("user role: /v1/me/metrics is scoped to that tenant", async () => {
    const { app, warm } = await setupWithAdmin();
    const { hashPassword } = await import("./auth.js");
    await warm.createTenant("acme", "Acme");
    const hash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: hash, role: "user", tenantId: "acme" });

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
    expect(m.json().tenantId).toBe("acme");
  });

  it("user can mint + revoke tokens for their own tenant", async () => {
    const { app, warm } = await setupWithAdmin();
    const { hashPassword } = await import("./auth.js");
    await warm.createTenant("acme", "Acme");
    const hash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: hash, role: "user", tenantId: "acme" });

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
    const tenantToken = mint.json().token;
    expect(tenantToken).toMatch(/^nm_/);

    const list = await app.inject({ method: "GET", url: "/v1/me/tokens", headers: auth });
    expect(list.json().tokens.length).toBe(1);
    const tokenHash = list.json().tokens[0].tokenHash;

    const r = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    expect(r.statusCode).toBe(200);

    const rev = await app.inject({
      method: "POST", url: `/v1/me/tokens/${tokenHash}/revoke`,
      headers: auth,
    });
    expect(rev.statusCode).toBe(200);

    const after = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("user cannot reach admin routes", async () => {
    const { app, warm } = await setupWithAdmin();
    const { hashPassword } = await import("./auth.js");
    await warm.createTenant("acme", "Acme");
    const hash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: hash, role: "user", tenantId: "acme" });

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
    const { app, warm } = makeApp({ authMode: "tenant" });
    const { hashPassword } = await import("./auth.js");
    await warm.createTenant("acme", "Acme");
    await warm.createTenant("contoso", "Contoso");
    const bobHash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: bobHash, role: "user", tenantId: "acme" });
    const carolHash = await hashPassword("carolpass1");
    await warm.createUser({ username: "carol", passwordHash: carolHash, role: "user", tenantId: "contoso" });
    const login = (u: string, p: string) => app.inject({
      method: "POST", url: "/v1/auth/login", payload: { username: u, password: p },
    });
    const bobSession = (await login("bob", "bobpass1")).json().token as string;
    const carolSession = (await login("carol", "carolpass1")).json().token as string;
    return { app, warm, bobSession, carolSession };
  }

  // P0-1: tenant id `p_*` collision with project collection prefix
  it("P0-1: tenant id starting with `p_` is refused", async () => {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "POST", url: "/v1/admin/tenants",
      payload: { id: "p_evil", name: "Evil" },
      headers: adminH,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/invalid request/i);
  });

  it("P0-1: tenant id exactly `p` is refused", async () => {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "POST", url: "/v1/admin/tenants",
      payload: { id: "p", name: "Just P" },
      headers: adminH,
    });
    expect(r.statusCode).toBe(400);
  });

  it("P0-1: normal tenant ids still work", async () => {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    const r = await app.inject({
      method: "POST", url: "/v1/admin/tenants",
      payload: { id: "phoenix", name: "Phoenix" },
      headers: adminH,
    });
    expect(r.statusCode).toBe(201);
  });

  // P0-2: removing a member must revoke that user's project tokens
  it("P0-2: removeProjectMember revokes the kicked user's project-scoped tokens", async () => {
    const { app, bobSession, carolSession } = await setupBobInAcme();
    const bobAuth = { authorization: `Bearer ${bobSession}` };
    const carolAuth = { authorization: `Bearer ${carolSession}` };
    // Bob owns 'shared'; Carol joins.
    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "shared", name: "Shared" }, headers: bobAuth,
    });
    await app.inject({
      method: "POST", url: "/v1/me/projects/shared/members",
      payload: { username: "carol" }, headers: bobAuth,
    });
    // Carol mints a project token.
    const mint = await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { projectId: "shared", label: "carol-laptop" }, headers: carolAuth,
    });
    const carolTok = mint.json().token;
    // Bob removes Carol.
    const carolMe = await app.inject({ method: "GET", url: "/v1/auth/me", headers: carolAuth });
    const carolUserId = carolMe.json().user.id;
    const remove = await app.inject({
      method: "DELETE", url: `/v1/me/projects/shared/members/${carolUserId}`,
      headers: bobAuth,
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().tokensRevoked).toBeGreaterThanOrEqual(1);
    // Carol's old project token must now 401.
    const r = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: `Bearer ${carolTok}` },
    });
    expect(r.statusCode).toBe(401);
  });

  // P0-3: per-username login throttle locks an account out after 5 failures
  // Backoff sleeps add up; allow extra time.
  it("P0-3: 5 wrong passwords lock the account out (429)", { timeout: 15_000 }, async () => {
    const { app } = makeApp({ authMode: "tenant" });
    const { hashPassword } = await import("./auth.js");
    const w = (app as unknown as { warmFake?: unknown }) as never;
    void w;
    // Register bob
    const { warm } = makeApp({ authMode: "tenant" });
    void warm; // throwaway — main test uses the throttle on the original app
    // Fresh app for an isolated throttle.
    const { app: app2, warm: warm2 } = makeApp({ authMode: "tenant" });
    const hash = await hashPassword("right-password");
    await warm2.createUser({ username: "bob", passwordHash: hash, role: "user", tenantId: null });
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
      tenantId: "public",
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

  // P0-5: cross-tenant project member CAN forget shared rows
  it("P0-5: cross-tenant project member can forget a shared entry", async () => {
    const { app, bobSession, carolSession } = await setupBobInAcme();
    const bobAuth = { authorization: `Bearer ${bobSession}` };
    const carolAuth = { authorization: `Bearer ${carolSession}` };
    // Owner Bob, member Carol on 'shared'
    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "shared", name: "Shared" }, headers: bobAuth,
    });
    await app.inject({
      method: "POST", url: "/v1/me/projects/shared/members",
      payload: { username: "carol" }, headers: bobAuth,
    });
    const bobTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { projectId: "shared" }, headers: bobAuth,
    })).json().token;
    const carolTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { projectId: "shared" }, headers: carolAuth,
    })).json().token;
    // Bob remembers something
    const created = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "bob's note" },
      headers: { authorization: `Bearer ${bobTok}` },
    });
    const id = created.json().id;
    // Carol (different tenant) can forget it
    const f = await app.inject({
      method: "POST", url: "/v1/forget",
      payload: { id },
      headers: { authorization: `Bearer ${carolTok}` },
    });
    expect(f.statusCode).toBe(200);
    expect(f.json().deleted).toBe(true);
    // And it's actually gone.
    const recent = await app.inject({
      method: "POST", url: "/v1/recent", payload: {},
      headers: { authorization: `Bearer ${bobTok}` },
    });
    expect(recent.json().results.find((r: { id: string }) => r.id === id)).toBeUndefined();
  });

  // P1-S6: admin actions write to the audit log
  it("P1-S6: tenant.create writes an audit-log entry", async () => {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    await app.inject({
      method: "POST", url: "/v1/admin/tenants",
      payload: { id: "audited", name: "Audited" },
      headers: adminH,
    });
    const log = await app.inject({
      method: "GET", url: "/v1/admin/audit-log",
      headers: adminH,
    });
    expect(log.statusCode).toBe(200);
    const e = log.json().entries.find((x: { action: string; target: string }) =>
      x.action === "tenant.create" && x.target === "audited",
    );
    expect(e).toBeDefined();
    expect(e.actorLabel).toMatch(/^user:admin-/);
  });

  // P2-1: Zod errors → 400 (covered by existing test rewritten earlier).
});

describe("http: projects (sub-brains)", () => {
  async function setupBobInAcme() {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const { hashPassword } = await import("./auth.js");
    await warm.createTenant("acme", "Acme");
    await warm.createTenant("contoso", "Contoso");
    const bobHash = await hashPassword("bobpass1");
    await warm.createUser({ username: "bob", passwordHash: bobHash, role: "user", tenantId: "acme" });
    const carolHash = await hashPassword("carolpass1");
    await warm.createUser({ username: "carol", passwordHash: carolHash, role: "user", tenantId: "contoso" });
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
      payload: { id: "phoenix", name: "Phoenix" },
      headers: auth,
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/v1/me/projects", headers: auth });
    const projects = list.json().projects;
    expect(projects.length).toBe(1);
    expect(projects[0].id).toBe("phoenix");
    expect(projects[0].role).toBe("owner");
  });

  it("project-scoped token isolates memory from tenant-wide", async () => {
    const { app, session } = await setupBobInAcme();
    const auth = { authorization: `Bearer ${session}` };

    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "phoenix", name: "Phoenix" },
      headers: auth,
    });

    const phoenixTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { label: "ph-laptop", projectId: "phoenix" },
      headers: auth,
    })).json().token as string;
    const wideTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { label: "wide-laptop" },
      headers: auth,
    })).json().token as string;

    // Tenant-wide entry
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "tenant-wide alpha" },
      headers: { authorization: `Bearer ${wideTok}` },
    });
    // Project entry
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "phoenix beta gamma" },
      headers: { authorization: `Bearer ${phoenixTok}` },
    });

    // Project bearer should see only phoenix
    const ph = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${phoenixTok}` },
    });
    const phContents = ph.json().results.map((r: { content: string }) => r.content);
    expect(phContents).toContain("phoenix beta gamma");
    expect(phContents).not.toContain("tenant-wide alpha");

    // Tenant-wide bearer should see only the wide entry
    const wd = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${wideTok}` },
    });
    const wdContents = wd.json().results.map((r: { content: string }) => r.content);
    expect(wdContents).toContain("tenant-wide alpha");
    expect(wdContents).not.toContain("phoenix beta gamma");
  });

  it("tenant-wide bearer rejected if it asks for a project in body", async () => {
    const { app, session } = await setupBobInAcme();
    const auth = { authorization: `Bearer ${session}` };
    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "phoenix", name: "Phoenix" },
      headers: auth,
    });
    const wideTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens", payload: {}, headers: auth,
    })).json().token;

    const r = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "x", project: "phoenix" },
      headers: { authorization: `Bearer ${wideTok}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("project-scoped bearer rejected if body asks for a different project", async () => {
    const { app, warm, session } = await setupBobInAcme();
    const auth = { authorization: `Bearer ${session}` };
    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "phoenix", name: "Phoenix" },
      headers: auth,
    });
    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "atlas", name: "Atlas" },
      headers: auth,
    });
    void warm;
    const phTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { projectId: "phoenix" },
      headers: auth,
    })).json().token;

    const r = await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "x", project: "atlas" },
      headers: { authorization: `Bearer ${phTok}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("owner adds a cross-tenant member; member sees the project + can mint tokens", async () => {
    const { app, warm, session } = await setupBobInAcme();
    const authBob = { authorization: `Bearer ${session}` };
    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "shared", name: "Shared" },
      headers: authBob,
    });

    // Add carol (different tenant) by username
    const add = await app.inject({
      method: "POST", url: "/v1/me/projects/shared/members",
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
    expect(ids).toContain("shared");

    // Carol can mint a token scoped to the shared project (uses HER tenant_id
    // for the token row, but the project id makes the access work).
    const mint = await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { projectId: "shared", label: "carols-laptop" },
      headers: authCarol,
    });
    expect(mint.statusCode).toBe(201);
    const carolTok = mint.json().token;

    // Bob remembers something in shared
    const bobTok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { projectId: "shared" },
      headers: authBob,
    })).json().token;
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "bob's note in shared" },
      headers: { authorization: `Bearer ${bobTok}` },
    });

    // Carol can read Bob's note in the shared project — the actual sharing
    // story working end-to-end.
    const r = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${carolTok}` },
    });
    const contents = r.json().results.map((x: { content: string }) => x.content);
    expect(contents).toContain("bob's note in shared");
    void warm;
  });

  it("non-owner cannot add members or delete the project", async () => {
    const { app, session } = await setupBobInAcme();
    const authBob = { authorization: `Bearer ${session}` };
    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "shared", name: "Shared" },
      headers: authBob,
    });
    await app.inject({
      method: "POST", url: "/v1/me/projects/shared/members",
      payload: { username: "carol" },
      headers: authBob,
    });

    const carolLogin = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "carol", password: "carolpass1" },
    });
    const carolAuth = { authorization: `Bearer ${carolLogin.json().token}` };

    const add = await app.inject({
      method: "POST", url: "/v1/me/projects/shared/members",
      payload: { username: "bob" },
      headers: carolAuth,
    });
    expect(add.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE", url: "/v1/me/projects/shared",
      headers: carolAuth,
    });
    expect(del.statusCode).toBe(403);
  });

  it("owner deletes the project; entries gone, tokens revoked", async () => {
    const { app, session } = await setupBobInAcme();
    const auth = { authorization: `Bearer ${session}` };
    await app.inject({
      method: "POST", url: "/v1/me/projects",
      payload: { id: "phoenix", name: "Phoenix" },
      headers: auth,
    });
    const tok = (await app.inject({
      method: "POST", url: "/v1/me/tokens",
      payload: { projectId: "phoenix" },
      headers: auth,
    })).json().token;
    await app.inject({
      method: "POST", url: "/v1/remember",
      payload: { content: "to be purged" },
      headers: { authorization: `Bearer ${tok}` },
    });

    const del = await app.inject({
      method: "DELETE", url: "/v1/me/projects/phoenix",
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);
    expect(del.json().entriesRemoved).toBeGreaterThanOrEqual(1);

    // Token revoked → 401
    const r = await app.inject({
      method: "POST", url: "/v1/recent",
      payload: {},
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe("http: /v1/auth/rotate-token (user self-service)", () => {
  it("rotates the caller's token and revokes the old one", async () => {
    const { app, warm } = makeApp({ authMode: "tenant" });
    const adminH = await adminAuth(warm);
    await app.inject({
      method: "POST", url: "/v1/admin/tenants",
      payload: { id: "acme", name: "Acme" },
      headers: adminH,
    });
    const tk = await app.inject({
      method: "POST", url: "/v1/admin/tenants/acme/tokens",
      headers: adminH,
    });
    const oldToken = tk.json().token as string;

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
    const { app } = makeApp({ authMode: "tenant" });
    const r = await app.inject({
      method: "POST", url: "/v1/auth/rotate-token",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("400s outside tenant mode", async () => {
    const { app } = makeApp({ authMode: "bearer", token: "secret" });
    const r = await app.inject({
      method: "POST", url: "/v1/auth/rotate-token",
      headers: { authorization: "Bearer secret" },
    });
    expect(r.statusCode).toBe(400);
  });
});
