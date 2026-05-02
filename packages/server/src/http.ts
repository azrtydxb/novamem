/**
 * Fastify HTTP transport. Mirrors the engine API one-to-one with light
 * validation via Zod on the request bodies, plus an MCP/SSE bridge for
 * remote MCP-aware hosts.
 */

import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

import type { MemoryEngine } from "./engine/index.js";
import { buildMcpServer } from "./mcp.js";

/** Hard cap on stored content size — prevents a single oversized POST from
 *  exhausting memory or the DB row size limit. ~256KB is plenty for any
 *  reasonable memory entry. */
const MAX_CONTENT_BYTES = 256 * 1024;

const SearchBody = z.object({
  query: z.string().min(1).max(8 * 1024),
  k: z.number().int().positive().max(100).optional(),
  namespace: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  weights: z
    .object({
      keyword: z.number().optional(),
      vector: z.number().optional(),
      graph: z.number().optional(),
    })
    .optional(),
});

const RememberBody = z.object({
  content: z.string().min(1).max(MAX_CONTENT_BYTES),
  namespace: z.string().max(128).optional(),
  source: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
});

const DecayBody = z.object({
  effectiveDays: z.number().positive().optional(),
});

const RecentBody = z.object({
  namespace: z.string().max(128).optional(),
  k: z.number().int().positive().max(200).optional(),
  /** ISO-8601 lower bound. */
  since: z.string().optional(),
});

const NeighborsBody = z.object({
  id: z.string().min(1).max(128),
  depth: z.number().int().positive().max(3).optional(),
  k: z.number().int().positive().max(50).optional(),
});

const ForgetBody = z.object({
  id: z.string().min(1).max(128),
});

export interface HttpOptions {
  engine: MemoryEngine;
  auth: { mode: "none" | "bearer"; token?: string };
  /** Per-IP requests-per-minute. Default 600 (10/sec sustained). */
  rateLimitPerMinute?: number;
}

export function buildHttpServer(opts: HttpOptions): FastifyInstance {
  // Fail-fast: bearer mode without a token bricks the service silently
  // (every request 401s). Refuse to start instead of pretending to work.
  if (opts.auth.mode === "bearer" && !opts.auth.token) {
    throw new Error("auth.mode = 'bearer' requires auth.token to be set (NOVAMEM_AUTH_TOKEN)");
  }

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 2 * 1024 * 1024 });
  app.register(cors, { origin: true });
  app.register(rateLimit, {
    max: opts.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    // Skip /health so liveness probes don't burn the budget.
    skipOnError: true,
    allowList: (req) => req.url === "/health",
  });

  // Bearer auth hook (skipped for public endpoints).
  app.addHook("onRequest", async (req, reply) => {
    if (opts.auth.mode === "none") return;
    if (req.url === "/health" || req.url === "/openapi.json") return;
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    if (header.slice("Bearer ".length) !== opts.auth.token) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
  });

  app.get("/health", async (_req, reply) => {
    const h = await opts.engine.health();
    reply.code(h.ok ? 200 : 503).send(h);
  });

  app.post("/v1/search", async (req, reply) => {
    const body = SearchBody.parse(req.body);
    const r = await opts.engine.search(body);
    reply.send(r);
  });

  app.post("/v1/remember", async (req, reply) => {
    const body = RememberBody.parse(req.body);
    const r = await opts.engine.remember(body);
    reply.code(201).send(r);
  });

  app.post("/v1/decay", async (req, reply) => {
    const body = DecayBody.parse(req.body ?? {});
    const r = await opts.engine.decay({ effectiveDaysOverride: body.effectiveDays });
    reply.send(r);
  });

  app.post("/v1/recent", async (req, reply) => {
    const body = RecentBody.parse(req.body ?? {});
    reply.send(await opts.engine.recent(body));
  });

  app.post("/v1/neighbors", async (req, reply) => {
    const body = NeighborsBody.parse(req.body);
    reply.send(await opts.engine.neighbors(body));
  });

  app.post("/v1/forget", async (req, reply) => {
    const body = ForgetBody.parse(req.body);
    reply.send(await opts.engine.forget(body.id));
  });

  app.get("/v1/stats", async (_req, reply) => {
    reply.send(await opts.engine.stats());
  });

  app.get("/openapi.json", async (_req, reply) => {
    reply.send(openapiSpec());
  });

  // ─── MCP via SSE ──────────────────────────────────────────────────
  // The same engine is exposed through buildMcpServer() — over stdio for
  // local hosts (packages/server/src/main.ts can launch that), and over
  // HTTP+SSE here for remote hosts.
  //
  // GET  /mcp/sse                    — opens the event stream, returns sessionId
  // POST /mcp/messages?sessionId=…   — sends JSON-RPC requests on that session
  //
  // Per-session transports live in this map for the lifetime of the
  // SSE connection. They're disposed when the client disconnects.

  const sseTransports = new Map<string, SSEServerTransport>();

  app.get("/mcp/sse", async (req, reply) => {
    const transport = new SSEServerTransport("/mcp/messages", reply.raw);
    const sessionId = transport.sessionId;
    sseTransports.set(sessionId, transport);
    const mcpServer = buildMcpServer(opts.engine);
    await mcpServer.connect(transport);
    req.log.info({ sessionId }, "mcp-sse: session opened");
    reply.raw.on("close", () => {
      sseTransports.delete(sessionId);
      mcpServer.close().catch(() => undefined);
      req.log.info({ sessionId }, "mcp-sse: session closed");
    });
  });

  app.post("/mcp/messages", async (req, reply) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId;
    if (!sessionId) return reply.code(400).send({ error: "missing sessionId" });
    const transport = sseTransports.get(sessionId);
    if (!transport) return reply.code(404).send({ error: "unknown sessionId" });
    await transport.handlePostMessage(req.raw, reply.raw, req.body);
  });

  return app;
}

function openapiSpec() {
  return {
    openapi: "3.1.0",
    info: { title: "novamem", version: "0.1.0" },
    paths: {
      "/health": { get: { responses: { 200: { description: "ok" } } } },
      "/v1/search": { post: { responses: { 200: { description: "ranked results" } } } },
      "/v1/remember": { post: { responses: { 201: { description: "created" } } } },
      "/v1/recent": { post: { responses: { 200: { description: "recent entries by namespace" } } } },
      "/v1/neighbors": { post: { responses: { 200: { description: "graph-neighbour entries" } } } },
      "/v1/forget": { post: { responses: { 200: { description: "deletion summary" } } } },
      "/v1/decay": { post: { responses: { 200: { description: "decay run summary" } } } },
      "/v1/stats": { get: { responses: { 200: { description: "stats snapshot" } } } },
      "/mcp/sse": { get: { responses: { 200: { description: "SSE event stream for MCP transport" } } } },
      "/mcp/messages": { post: { responses: { 200: { description: "JSON-RPC message sink for an SSE session" } } } },
    },
  };
}
