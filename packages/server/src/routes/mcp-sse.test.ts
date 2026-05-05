/**
 * SSE concurrency-cap regression test (issue #26). Opens MAX+1 SSE
 * sessions for the same user and asserts the (MAX+1)th gets 429.
 *
 * SSE responses don't complete until the client disconnects, so we drive
 * the server through `listen()` + real HTTP requests with an
 * AbortController per session — `app.inject()` would buffer indefinitely.
 *
 * Idle-session expiry is intentionally not exercised here: the 30 min
 * timer interacts poorly with vitest's fake-timer / real-network split,
 * and inducing a synthetic clock skew through SSEServerTransport's own
 * keep-alive plumbing is more code than the bug it would catch. The
 * reaper is a `setInterval`-driven sweep over `lastActivity`, the same
 * pattern used by the cookie-session test infra elsewhere in this repo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { buildHttpServer } from "../http.js";
import { MemoryEngine } from "../engine/index.js";
import {
  asCold,
  asGraph,
  asWarm,
  FakeColdStore,
  FakeEmbedder,
  FakeGraphStore,
  FakeWarmStore,
} from "../test-fakes.js";

let app: FastifyInstance;
let baseUrl: string;
const openControllers: AbortController[] = [];

beforeAll(async () => {
  const warm = new FakeWarmStore();
  const cold = new FakeColdStore();
  const graph = new FakeGraphStore();
  const engine = new MemoryEngine({
    warm: asWarm(warm),
    cold: asCold(cold),
    graph: asGraph(graph),
    embedder: new FakeEmbedder(),
    defaultEffectiveDays: 7,
  });
  app = buildHttpServer({
    engine,
    warm: asWarm(warm),
    auth: { mode: "none" },
    rateLimitPerMinute: 100_000,
    adminDashboard: false,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const c of openControllers) c.abort();
  await app.close();
});

describe("mcp-sse: per-user concurrency cap (issue #26)", () => {
  it("rejects the 11th concurrent SSE session for the same user with 429", async () => {
    // Open 10 SSE sessions — each kept alive by a long-running fetch
    // whose AbortController we hold on to so afterAll can drain them.
    const opened: Response[] = [];
    for (let i = 0; i < 10; i++) {
      const ctrl = new AbortController();
      openControllers.push(ctrl);
      // SSE handshake — we await the response headers but NOT the body.
      // Fastify writes the 200 + content-type once the route handler
      // calls `mcpServer.connect(transport)`, which is synchronous w.r.t.
      // the headers.
      const res = await fetch(`${baseUrl}/mcp/sse`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      opened.push(res);
    }
    // The 11th must be rejected with 429 before any new session slot is
    // allocated. `auth.mode = none` means every caller is the SYSTEM_USER
    // so all 11 attempts share the same per-user budget.
    const ctrl = new AbortController();
    openControllers.push(ctrl);
    const over = await fetch(`${baseUrl}/mcp/sse`, { signal: ctrl.signal });
    expect(over.status).toBe(429);
    const body = (await over.json()) as { error?: string };
    expect(body.error).toMatch(/too many/i);
    // Best-effort drain so the body reader for `opened` doesn't leak —
    // the streams stay open until afterAll aborts their controllers.
    for (const r of opened) {
      try {
        // discard the reader without reading; cancel releases the lock.
        await r.body?.cancel();
      } catch {
        // ignore
      }
    }
  }, 15_000);
});

/**
 * Session-owner check on POST /mcp/messages (issue #57). The SSE
 * sessionId is carried in the query string and is more leak-prone than
 * an Authorization header; a different authenticated user must not be
 * able to drive another user's MCP session by guessing/learning their
 * sessionId.
 *
 * Uses auth.mode = "user" with the FakeWarmStore so each user gets a
 * distinct nm_… bearer that resolves to a different req.userId.
 */
describe("mcp-sse: session-owner check on POST /mcp/messages (issue #57)", () => {
  let app2: FastifyInstance;
  let baseUrl2: string;
  const ctrls: AbortController[] = [];

  afterEach(async () => {
    for (const c of ctrls) c.abort();
    ctrls.length = 0;
    if (app2) await app2.close();
  });

  it("returns 403 when user B posts to user A's sessionId", async () => {
    const warm = new FakeWarmStore();
    const cold = new FakeColdStore();
    const graph = new FakeGraphStore();
    const engine = new MemoryEngine({
      warm: asWarm(warm),
      cold: asCold(cold),
      graph: asGraph(graph),
      embedder: new FakeEmbedder(),
      defaultEffectiveDays: 7,
    });
    app2 = buildHttpServer({
      engine,
      warm: asWarm(warm),
      auth: { mode: "user" },
      rateLimitPerMinute: 100_000,
      adminDashboard: false,
    });
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const addr = app2.server.address() as AddressInfo;
    baseUrl2 = `http://127.0.0.1:${addr.port}`;

    // Create two users with distinct bearers.
    const userA = await warm.createUser({
      username: "alice",
      passwordHash: "x",
      role: "user",
      userId: null,
    });
    const userB = await warm.createUser({
      username: "bob",
      passwordHash: "x",
      role: "user",
      userId: null,
    });
    const tokA = await warm.createUserToken(userA.id, "a-token", null);
    const tokB = await warm.createUserToken(userB.id, "b-token", null);
    expect(tokA && tokB).toBeTruthy();

    // User A opens an SSE session and we capture the sessionId from the
    // first `endpoint` event (SSEServerTransport writes it as the first
    // message: `event: endpoint\ndata: /mcp/messages?sessionId=...`).
    const ctrl = new AbortController();
    ctrls.push(ctrl);
    const sseRes = await fetch(`${baseUrl2}/mcp/sse`, {
      headers: { authorization: `Bearer ${tokA!.token}` },
      signal: ctrl.signal,
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sessionId: string | undefined;
    // Read until we see the endpoint frame. The transport writes it
    // immediately after `connect()`, so this resolves promptly.
    while (!sessionId) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/sessionId=([A-Za-z0-9_-]+)/);
      if (m) sessionId = m[1];
    }
    expect(sessionId).toBeTruthy();

    // User B tries to POST to user A's session — must 403.
    const cross = await fetch(
      `${baseUrl2}/mcp/messages?sessionId=${sessionId}`,
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

    // Drain the reader without keeping the lock.
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }, 15_000);
});
