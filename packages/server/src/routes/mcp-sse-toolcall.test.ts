/**
 * Repro for the conformance finding: tools/call over the legacy SSE
 * transport is 202-accepted but its JSON-RPC response never reaches the
 * SSE stream, while initialize and tools/list respond fine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { buildHttpServer } from "../http.js";
import { MemoryEngine } from "../engine/index.js";
import { asCold, asWarm, FakeColdStore, FakeEmbedder, FakeWarmStore } from "../test-fakes.js";

let app: FastifyInstance;
let baseUrl: string;
const ctrl = new AbortController();

beforeAll(async () => {
  const warm = new FakeWarmStore();
  const engine = new MemoryEngine({
    warm: asWarm(warm),
    cold: asCold(new FakeColdStore()),
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
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  ctrl.abort();
  await app.close();
});

describe("mcp-sse: tools/call round-trip", () => {
  it("tools/call response arrives on the SSE stream", async () => {
    const sse = await fetch(`${baseUrl}/mcp/sse`, { signal: ctrl.signal });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (pred: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) return false;
        const { value, done } = await reader.read();
        if (done) return pred();
        buf += dec.decode(value, { stream: true });
      }
      return true;
    };
    expect(await readUntil(() => /sessionId=/.test(buf), 5000), "endpoint frame with sessionId").toBe(true);
    const sid = buf.match(/sessionId=([A-Za-z0-9-]+)/)![1];
    const post = (body: unknown) =>
      fetch(`${baseUrl}/mcp/messages?sessionId=${sid}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } })).status).toBe(202);
    expect(await readUntil(() => buf.includes('"id":1'), 5000)).toBe(true);
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_stats", arguments: {} } })).status).toBe(202);
    const answered = await readUntil(() => buf.includes('"id":3'), 8000);
    if (!answered) throw new Error(`tools/call never answered; stream tail: ${buf.slice(-300)}`);
    await reader.cancel();
  }, 30_000);
});
