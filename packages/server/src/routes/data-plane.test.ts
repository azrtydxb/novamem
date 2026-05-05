/**
 * Route tests for the admin-only gates added to /v1/dream-cycle and
 * /v1/reap-orphans (issue #45). These endpoints scan memory across all
 * users and were previously reachable by any authenticated user; they
 * must now return 403 for non-admins.
 */
import { describe, expect, it } from "vitest";

import { buildHttpServer } from "../http.js";
import {
  asWarm,
  FakeWarmStore,
  makeEngine,
} from "../test-fakes.js";

function makeApp() {
  const { engine, warm, cold, graph, metrics } = makeEngine({
    defaultEffectiveDays: 7,
    withMetrics: true,
  });
  void cold;
  void graph;
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
    auth: { mode: "none" },
    rateLimitPerMinute: 100_000,
    metrics,
    betterAuth: fakeBA,
  });
  return { app, warm };
}

async function userSession(
  warm: FakeWarmStore,
  role: "admin" | "user",
): Promise<{ authorization: string }> {
  const username = `${role}-${Math.random().toString(36).slice(2, 10)}`;
  await warm.createUser({
    username,
    passwordHash: "test-bcrypt-not-checked-for-session-resolve",
    role,
  });
  let userId = username;
  for (const u of warm.users.values()) {
    if (u.username === username) {
      userId = u.id;
      break;
    }
  }
  const sess = await warm.createSession(userId, 24 * 3600 * 1000);
  return { authorization: `Bearer ${sess.token}` };
}

describe("data-plane: admin-only gates (issue #45)", () => {
  it("/v1/dream-cycle returns 403 for non-admin users", async () => {
    const { app, warm } = makeApp();
    const headers = await userSession(warm, "user");
    const r = await app.inject({
      method: "POST",
      url: "/v1/dream-cycle",
      headers,
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });

  it("/v1/dream-cycle passes the admin gate for admin users", async () => {
    // We only assert that the admin gate doesn't reject (the engine call
    // itself depends on warm-store SQL the fake doesn't cover, so it can
    // 500 — what we care about here is that it's NOT a 403).
    const { app, warm } = makeApp();
    const headers = await userSession(warm, "admin");
    const r = await app.inject({
      method: "POST",
      url: "/v1/dream-cycle",
      headers,
      payload: {},
    });
    expect(r.statusCode).not.toBe(403);
  });

  it("/v1/reap-orphans returns 403 for non-admin users", async () => {
    const { app, warm } = makeApp();
    const headers = await userSession(warm, "user");
    const r = await app.inject({
      method: "POST",
      url: "/v1/reap-orphans",
      headers,
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });

  it("/v1/reap-orphans is reachable for admin users", async () => {
    const { app, warm } = makeApp();
    const headers = await userSession(warm, "admin");
    const r = await app.inject({
      method: "POST",
      url: "/v1/reap-orphans",
      headers,
      payload: {},
    });
    expect(r.statusCode).toBe(200);
  });
});

/**
 * Issue #55: /v1/decay scans and updates memory_entries globally and
 * accepts an effectiveDaysOverride that affects everyone's tiering. It
 * must therefore be admin-only, mirroring /v1/dream-cycle and
 * /v1/reap-orphans.
 */
describe("data-plane: /v1/decay admin-only gate (issue #55)", () => {
  it("/v1/decay returns 403 for non-admin users", async () => {
    const { app, warm } = makeApp();
    const headers = await userSession(warm, "user");
    const r = await app.inject({
      method: "POST",
      url: "/v1/decay",
      headers,
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });

  it("/v1/decay passes the admin gate for admin users", async () => {
    // We only assert that the admin gate doesn't reject — the engine
    // call itself depends on warm-store SQL the fake doesn't fully
    // emulate, so the route may return non-200; what we care about is
    // that it is NOT a 403.
    const { app, warm } = makeApp();
    const headers = await userSession(warm, "admin");
    const r = await app.inject({
      method: "POST",
      url: "/v1/decay",
      headers,
      payload: {},
    });
    expect(r.statusCode).not.toBe(403);
  });
});
