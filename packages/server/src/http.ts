/**
 * Fastify HTTP transport. Mirrors the engine API one-to-one with light
 * validation via Zod on the request bodies.
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";

import type { MemoryEngine } from "./engine/index.js";

const SearchBody = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(100).optional(),
  namespace: z.string().optional(),
  agentName: z.string().optional().nullable(),
  weights: z
    .object({
      keyword: z.number().optional(),
      vector: z.number().optional(),
      graph: z.number().optional(),
    })
    .optional(),
});

const RememberBody = z.object({
  content: z.string().min(1),
  namespace: z.string().optional(),
  source: z.string().optional(),
  agentName: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
});

const DecayBody = z.object({
  effectiveDays: z.number().positive().optional(),
});

const PromoteBody = z.object({
  minHits: z.number().int().nonnegative().optional(),
});

const RecentBody = z.object({
  namespace: z.string().optional(),
  k: z.number().int().positive().max(200).optional(),
  /** ISO-8601 lower bound. */
  since: z.string().optional(),
});

const NeighborsBody = z.object({
  id: z.string().min(1),
  depth: z.number().int().positive().max(3).optional(),
  k: z.number().int().positive().max(50).optional(),
});

const ForgetBody = z.object({
  id: z.string().min(1),
});

export interface HttpOptions {
  engine: MemoryEngine;
  auth: { mode: "none" | "bearer"; token?: string };
}

export function buildHttpServer(opts: HttpOptions): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.register(cors, { origin: true });

  // Bearer auth hook (skipped for /health and /openapi.json).
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

  app.post("/v1/promote", async (req, reply) => {
    // Promotion is currently a no-op stub — promotion semantics will land
    // alongside the candidate-tracker feature. Returning 200 keeps callers
    // happy.
    PromoteBody.parse(req.body ?? {});
    reply.send({ promoted: 0 });
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
      "/v1/promote": { post: { responses: { 200: { description: "promote run summary" } } } },
      "/v1/stats": { get: { responses: { 200: { description: "stats snapshot" } } } },
    },
  };
}
