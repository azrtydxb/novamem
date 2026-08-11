/**
 * Consolidated security regression suite (issue #70).
 *
 * One readable file that asserts each boundary called out in the recent
 * security batch. If any of these tests fail, the security batch
 * regressed. Coverage details:
 *
 *  - #55 — `/v1/decay` is admin-only (403 for non-admin bearers).
 *  - #56 — `/api/auth/sign-up/email` is NOT exposed (404 via the
 *          Better Auth passthrough deny-list); same for any other path
 *          not on the allowlist.
 *  - #57 — `/mcp/messages` rejects cross-user POSTs to a foreign
 *          sessionId with 403.
 *  - #58 — `/api/auth/admin/*` only accepts the explicit allowlisted
 *          endpoints; an unknown one (e.g. `some-future-method`) 404s.
 *
 * Existing tests in `http.test.ts`, `routes/data-plane.test.ts`,
 * `routes/mcp-sse.test.ts` are NOT removed — this file is the canonical
 * top-level "did the security boundary regress?" check.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { buildHttpServer } from "./http.js";
import {
  asCold,
  asWarm,
  FakeColdStore,
  FakeEmbedder,
  FakeWarmStore,
  makeEngine,
} from "./test-fakes.js";
import { MemoryEngine } from "./engine/index.js";

/** Same fake Better Auth shim as http.test.ts — resolves `ns_…` session
 *  bearers via the in-memory warm store. We don't import the helper from
 *  http.test.ts to keep this suite self-contained per the task brief. */
function makeApp(authMode: "none" | "user" = "user") {
  const { engine, warm, cold, graph, metrics } = makeEngine({
    defaultEffectiveDays: 7,
    withMetrics: true,
  });
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
  };
  const app = buildHttpServer({
    engine,
    warm: asWarm(warm),
    auth: { mode: authMode },
    rateLimitPerMinute: 100_000,
    metrics,
    adminDashboard: true,
    betterAuth: fakeBA,
  });
  return { app, warm, cold, graph };
}

async function userAuth(
  warm: FakeWarmStore,
  username: string,
  role: "admin" | "user" = "user",
): Promise<{ authorization: string; userId: string }> {
  await warm.createUser({
    username,
    passwordHash: "test-not-checked",
    role,
  });
  let userId = username;
  for (const u of warm.users.values()) {
    if (u.username === username) { userId = u.id; break; }
  }
  const sess = await warm.createSession(userId, 24 * 3600 * 1000);
  return { authorization: `Bearer ${sess.token}`, userId };
}

describe("security: /v1/decay is admin-only (#55)", () => {
  it("returns 403 for a non-admin user bearer", async () => {
    const { app, warm } = makeApp("user");
    const bob = await userAuth(warm, "bob");
    const r = await app.inject({
      method: "POST",
      url: "/v1/decay",
      payload: {},
      headers: { authorization: bob.authorization },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/admin/i);
  });

  it("returns 200 for an admin session", async () => {
    const { app, warm } = makeApp("user");
    const admin = await userAuth(warm, "alice@ops.test", "admin");
    const r = await app.inject({
      method: "POST",
      url: "/v1/decay",
      payload: {},
      headers: { authorization: admin.authorization },
    });
    expect(r.statusCode).toBe(200);
  });

  it("rejects unauthenticated callers with 401 (auth precedes role check)", async () => {
    const { app } = makeApp("user");
    const r = await app.inject({
      method: "POST",
      url: "/v1/decay",
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });
});

describe("security: public sign-up is not exposed (#56)", () => {
  it("/api/auth/sign-up/email returns 404 (not on allowlist)", async () => {
    const { app } = makeApp("user");
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "evil@example.com", password: "hunter22hunter22", name: "evil" },
    });
    expect(r.statusCode).toBe(404);
  });

  it("/api/auth/sign-up/email is also 404 for GET (no method-specific bypass)", async () => {
    const { app } = makeApp("user");
    const r = await app.inject({
      method: "GET",
      url: "/api/auth/sign-up/email",
    });
    expect(r.statusCode).toBe(404);
  });

  it("an arbitrary unknown /api/auth/* path returns 404", async () => {
    const { app } = makeApp("user");
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/some-other-disabled-route",
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("security: /api/auth/admin/* allowlist (#58)", () => {
  it("an unknown admin sub-path returns 404", async () => {
    const { app } = makeApp("user");
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/admin/some-future-method",
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });

  it("a different unknown admin sub-path also 404s", async () => {
    const { app } = makeApp("user");
    const r = await app.inject({
      method: "GET",
      url: "/api/auth/admin/wildcard-not-allowed",
    });
    expect(r.statusCode).toBe(404);
  });

  it("a known allowlisted admin path is reachable (forwards to Better Auth)", async () => {
    // The fake BA handler returns 501; we just need to see the request was
    // routed to the passthrough rather than the deny handler. 501 ≠ 404.
    const { app } = makeApp("user");
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/admin/list-users",
      payload: {},
    });
    expect(r.statusCode).not.toBe(404);
  });
});

describe("security: MCP SSE session ownership (#57)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let warm: FakeWarmStore;
  const ctrls: AbortController[] = [];

  beforeAll(async () => {
    warm = new FakeWarmStore();
    const cold = new FakeColdStore();
    const engine = new MemoryEngine({
      warm: asWarm(warm),
      cold: asCold(cold),
      embedder: new FakeEmbedder(),
      defaultEffectiveDays: 7,
    });
    app = buildHttpServer({
      engine,
      warm: asWarm(warm),
      auth: { mode: "user" },
      rateLimitPerMinute: 100_000,
      adminDashboard: false,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    for (const c of ctrls) c.abort();
    ctrls.length = 0;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("user B posting to user A's sessionId is rejected with 403", async () => {
    const userA = await warm.createUser({
      username: "alice-sse",
      passwordHash: "x",
      role: "user",
      userId: null,
    });
    const userB = await warm.createUser({
      username: "bob-sse",
      passwordHash: "x",
      role: "user",
      userId: null,
    });
    const tokA = await warm.createUserToken(userA.id, "a", null);
    const tokB = await warm.createUserToken(userB.id, "b", null);
    expect(tokA && tokB).toBeTruthy();

    const ctrl = new AbortController();
    ctrls.push(ctrl);
    const sse = await fetch(`${baseUrl}/mcp/sse`, {
      headers: { authorization: `Bearer ${tokA!.token}` },
      signal: ctrl.signal,
    });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let sessionId: string | undefined;
    while (!sessionId) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/sessionId=([A-Za-z0-9_-]+)/);
      if (m) sessionId = m[1];
    }
    expect(sessionId).toBeTruthy();

    const cross = await fetch(
      `${baseUrl}/mcp/messages?sessionId=${sessionId}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokB!.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      },
    );
    expect(cross.status).toBe(403);
    const body = (await cross.json()) as { error?: string };
    expect(body.error).toMatch(/another user/i);

    try { await reader.cancel(); } catch { /* noop */ }
  }, 15_000);
});
