/**
 * Route tests for the "I found nothing" vs "I could not look" distinction.
 *
 * A Go client written against this API could not tell the two apart:
 * both arrived as HTTP 200 with an empty `results` array, so a tier
 * outage read to the caller as a confident "you have no such memory".
 * These lock in the split — 503 when a tier failed and produced nothing,
 * 200 + `degraded: true` when it failed but real results survived.
 */
import { describe, expect, it } from "vitest";

import { buildHttpServer } from "../http.js";
import { asWarm, FakeWarmStore, makeEngine } from "../test-fakes.js";

function makeApp(opts: { graphConnected?: boolean } = {}) {
  const { engine, warm, embedder, metrics } = makeEngine({
    graphConnected: opts.graphConnected ?? true,
    defaultEffectiveDays: 7,
    withMetrics: true,
  });
  engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
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
  return { app, warm, engine, embedder };
}

async function userSession(warm: FakeWarmStore): Promise<{ authorization: string }> {
  const username = `user-${Math.random().toString(36).slice(2, 10)}`;
  await warm.createUser({
    username,
    passwordHash: "test-bcrypt-not-checked-for-session-resolve",
    role: "user",
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

describe("/v1/search degraded semantics", () => {
  it("returns 503 when a tier failed and produced zero results", async () => {
    const { app, warm } = makeApp({ graphConnected: false });
    try {
      const headers = await userSession(warm);
      const r = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers,
        payload: { query: "anything at all", namespace: "default" },
      });
      // The store may well hold a matching memory; this response is simply
      // not evidence either way, so it must not read as "no such memory".
      expect(r.statusCode).toBe(503);
      const body = r.json();
      expect(body.degraded).toBe(true);
      expect(body.results).toEqual([]);
      expect(body.error).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("stays 200 with degraded:true when a tier failed but results survived", async () => {
    const { app, warm } = makeApp({ graphConnected: false });
    try {
      const headers = await userSession(warm);
      // Store a memory as the session user so keyword search can reach it.
      const stored = await app.inject({
        method: "POST",
        url: "/v1/remember",
        headers,
        payload: { content: "the qdrant collection lives on port 6333", namespace: "default" },
      });
      expect(stored.statusCode).toBe(201);

      const r = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers,
        payload: { query: "qdrant collection", namespace: "default" },
      });

      expect(r.statusCode).toBe(200);
      const body = r.json();
      // Graph is down, so the answer may be incomplete — but the results
      // that came back are real, and failing the request would discard them.
      expect(body.degraded).toBe(true);
      expect(body.results.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with degraded:false when every tier answered", async () => {
    const { app, warm } = makeApp({ graphConnected: true });
    try {
      const headers = await userSession(warm);
      const r = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers,
        payload: { query: "nothing matches this", namespace: "default" },
      });
      // A genuine empty result: every tier looked and none found anything.
      expect(r.statusCode).toBe(200);
      expect(r.json().degraded).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("marks the search degraded when the embedder is unreachable", async () => {
    const { app, warm, embedder } = makeApp({ graphConnected: true });
    try {
      const headers = await userSession(warm);
      embedder.fail = true;
      const r = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers,
        payload: { query: "nothing matches this", namespace: "default" },
      });
      // The exact shape of the original incident: a destroyed embeddings
      // host must not let a vector-blind search pass for a complete one.
      expect(r.statusCode).toBe(503);
      expect(r.json().degraded).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("/v1/neighbors degraded semantics", () => {
  it("returns 503 when the graph is unreachable and nothing came back", async () => {
    const { app, warm } = makeApp({ graphConnected: false });
    try {
      const headers = await userSession(warm);
      const r = await app.inject({
        method: "POST",
        url: "/v1/neighbors",
        headers,
        payload: { id: "01HSOMEENTRYID" },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().degraded).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("/v1/context degraded semantics", () => {
  // /v1/context is the endpoint an agent calls FIRST, and its guidance text
  // tells the caller to proceed when `relevant` is empty. Returning 200 with
  // an empty set during a tier outage therefore does not just lose a result —
  // it actively instructs the agent to carry on as though the store held
  // nothing. That is the most costly place in the API for this ambiguity.
  it("returns 503 when a tier failed and produced no relevant memories", async () => {
    const { app, warm } = makeApp({ graphConnected: false });
    try {
      const headers = await userSession(warm);
      const r = await app.inject({
        method: "POST",
        url: "/v1/context",
        headers,
        payload: { message: "anything at all", namespace: "default" },
      });
      expect(r.statusCode).toBe(503);
      const body = r.json();
      expect(body.relevant.degraded).toBe(true);
      expect(body.relevant.results).toEqual([]);
      expect(body.error).toBeTruthy();
      // The guidance that tells a caller to proceed must NOT ride along on a
      // response that means "I could not look".
      expect(body.guidance).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("stays 200 when every tier answered", async () => {
    const { app, warm } = makeApp();
    try {
      const headers = await userSession(warm);
      const r = await app.inject({
        method: "POST",
        url: "/v1/context",
        headers,
        payload: { message: "anything at all", namespace: "default" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().relevant.degraded).toBe(false);
      expect(r.json().guidance).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

describe("/v1/capture reports embedding state", () => {
  it("reports embedded:true on a healthy write", async () => {
    const { app, warm } = makeApp();
    try {
      const headers = await userSession(warm);
      const r = await app.inject({
        method: "POST",
        url: "/v1/capture",
        headers,
        payload: { content: "Pascal prefers dark roast coffee in the morning.", force: true },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().embedded).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("reports embedded:false when the embedder is down, and still stores", async () => {
    const { app, warm, embedder } = makeApp();
    try {
      const headers = await userSession(warm);
      embedder.fail = true;
      const r = await app.inject({
        method: "POST",
        url: "/v1/capture",
        headers,
        payload: { content: "Pascal prefers dark roast coffee in the morning.", force: true },
      });

      // Still a 201 — the memory is durably stored, and refusing the write
      // would lose it. But the caller can now tell "stored and searchable"
      // from "stored but not yet findable semantically".
      expect(r.statusCode).toBe(201);
      const body = r.json();
      expect(body.id).toBeTruthy();
      expect(body.embedded).toBe(false);
      expect(await warm.countPendingEmbedding()).toBe(1);
    } finally {
      await app.close();
    }
  });
});
