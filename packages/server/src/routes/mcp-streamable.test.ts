/**
 * Smoke test for the Streamable-HTTP MCP route. The full transport
 * protocol is covered by the SDK's own tests; here we just verify our
 * thin wiring: route registration, the no-session-id 400, and the
 * happy-path `initialize` returning a session id in the response
 * header so Codex / OpenCode / future hosts can drive subsequent
 * requests against it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { buildHttpServer } from "../http.js";
import { MemoryEngine } from "../engine/index.js";
import {
  asCold,
  asWarm,
  FakeColdStore,
  FakeEmbedder,
  FakeWarmStore,
} from "../test-fakes.js";

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  const warm = new FakeWarmStore();
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
    auth: { mode: "none" },
    rateLimitPerMinute: 100_000,
    adminDashboard: false,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

describe("mcp-streamable: /mcp transport", () => {
  it("rejects POST without Mcp-Session-Id when body isn't initialize", async () => {
    // Random tools/list call — not an initialize. Must 400, not crash.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").toMatch(/Mcp-Session-Id/);
  });

  it("rejects GET without Mcp-Session-Id", async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(400);
  });

  it("rejects DELETE without Mcp-Session-Id", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("creates a session on initialize POST and returns Mcp-Session-Id", async () => {
    // Minimal MCP initialize payload — matches the protocol shape the
    // SDK expects. Real clients carry capabilities + clientInfo too;
    // those are echoed back but don't gate the session creation.
    const initBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    };
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Streamable HTTP requires the client to advertise support for
        // both JSON and SSE responses on the initialize POST.
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initBody),
    });
    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i); // UUID-shaped
    // Drain the body — the SDK writes back either a JSON envelope or
    // an SSE stream depending on accept header negotiation. We don't
    // care about the contents here; the smoke test is the session id.
    await res.body?.cancel();
  });

  it("rejects requests for an unknown sessionId with 404", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "not-a-real-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/unknown sessionId/);
  });
});
