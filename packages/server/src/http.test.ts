import { describe, expect, it } from "vitest";

import { buildHttpServer } from "./http.js";
import { MemoryEngine } from "./engine/index.js";
import {
  asCold,
  asGraph,
  asWarm,
  FakeColdStore,
  FakeEmbedder,
  FakeGraphStore,
  FakeWarmStore,
} from "./test-fakes.js";

function makeApp(opts: { authMode?: "none" | "bearer"; token?: string } = {}) {
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
  const app = buildHttpServer({
    engine,
    auth: { mode: opts.authMode ?? "none", token: opts.token },
    rateLimitPerMinute: 100_000, // effectively off for tests
  });
  return { app, warm, cold, graph };
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
    expect(r.statusCode).toBe(500); // Zod throws inside handler → fastify 500
  });

  it("rejects oversized content (> 256KB)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/remember",
      payload: { content: "x".repeat(300_000) },
    });
    expect([400, 413, 500]).toContain(r.statusCode);
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
