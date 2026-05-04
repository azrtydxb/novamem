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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
