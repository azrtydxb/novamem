/**
 * Data-plane routes: /v1/{search,remember,recent,neighbors,forget,
 * memories/:id,decay,dream-cycle,reap-orphans,stats}.
 *
 * Each route attaches a zod schema via `schema: { body: … }`.
 * `fastify-type-provider-zod` runs validation at request time AND drives
 * the OpenAPI document — there is no separate spec to keep in sync.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  ContextBody,
  CaptureBody,
  DecayBody,
  ForgetBody,
  NeighborsBody,
  RecentBody,
  RememberBody,
  SearchBody,
  UpdateMemoryBody,
} from "./schemas.js";
import {
  adminAuth,
  checkProjectAccess,
  type RouteContext,
} from "./context.js";

export function register(app: FastifyInstance, ctx: RouteContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/search",
    {
      schema: {
        tags: ["memory"],
        summary: "Hybrid search (keyword + vector + graph) over the caller's memories",
        body: SearchBody,
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!(await checkProjectAccess(ctx, req.userId, body, reply))) return;
      const result = await ctx.engine.search(req.userId, body, req.bearerToken);
      reply.send(result);
    },
  );

  r.post(
    "/v1/context",
    {
      schema: {
        tags: ["memory"],
        summary: "Get first-pass memory context for a user message",
        body: ContextBody,
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!(await checkProjectAccess(ctx, req.userId, body, reply))) return;
      const k = body.k ?? 8;
      const relevant = await ctx.engine.search(req.userId, {
        query: body.message,
        k,
        namespace: body.namespace,
        includeNamespaces: body.includeNamespaces,
        project: body.project,
        includeProjects: body.includeProjects,
        weights: body.weights,
      }, req.bearerToken);
      const recent = await ctx.engine.recent(req.userId, {
        k: Math.min(k, 10),
        namespace: body.namespace,
        includeNamespaces: body.includeNamespaces,
        project: body.project,
        includeProjects: body.includeProjects,
      });
      reply.send({
        relevant,
        recent,
        guidance: "Use this context before answering. If relevant is empty, proceed but avoid asking the user to repeat context until targeted memory_search also misses.",
      });
    },
  );

  r.post(
    "/v1/capture",
    {
      schema: {
        tags: ["memory"],
        summary: "Capture a durable memory fact with provenance defaults",
        body: CaptureBody,
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!(await checkProjectAccess(ctx, req.userId, body, reply, false))) return;
      const result = await ctx.engine.remember(req.userId, {
        content: body.content,
        namespace: body.namespace,
        source: body.source ?? "memory_capture",
        agentName: body.agentName,
        project: body.project,
        metadata: body.metadata,
        sourceType: body.sourceType ?? "chat",
        capturedFrom: body.capturedFrom ?? "memory_capture",
        confidence: body.confidence,
        force: body.force,
      }, req.bearerToken);
      reply.code(201).send({ saved: result.id ? 1 : 0, results: [result] });
    },
  );

  r.post(
    "/v1/remember",
    {
      schema: {
        tags: ["memory"],
        summary: "Store a new memory entry",
        body: RememberBody,
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!(await checkProjectAccess(ctx, req.userId, body, reply, false))) return;
      const result = await ctx.engine.remember(req.userId, body, req.bearerToken);
      reply.code(201).send(result);
    },
  );

  r.post(
    "/v1/decay",
    {
      schema: {
        tags: ["lifecycle"],
        summary: "Trigger a decay sweep (admin only)",
        body: DecayBody.optional(),
        security: [{ SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      if (!adminAuth(req)) return reply.code(403).send({ error: "admin only" });
      const body = req.body ?? {};
      const result = await ctx.engine.decay({ effectiveDaysOverride: body.effectiveDays });
      reply.send(result);
    },
  );

  r.post(
    "/v1/dream-cycle",
    {
      schema: {
        tags: ["lifecycle"],
        summary: "Trigger the dedup-merge + edge-promotion pass (admin only)",
        security: [{ SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      if (!adminAuth(req)) return reply.code(403).send({ error: "admin only" });
      const result = await ctx.engine.dreamCycle();
      reply.send(result);
    },
  );

  r.put(
    "/v1/memories/:id",
    {
      schema: {
        tags: ["memory"],
        summary: "Update a memory entry's content / metadata / namespace",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: UpdateMemoryBody,
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;
      if (!(await checkProjectAccess(ctx, req.userId, body, reply, false))) return;
      const result = await ctx.engine.update(req.userId, id, body);
      if (!result.updated) {
        return reply.code(404).send({ error: "no such memory in your scope" });
      }
      reply.send({ id, ...result });
    },
  );

  r.post(
    "/v1/reap-orphans",
    {
      schema: {
        tags: ["lifecycle"],
        summary: "Trigger the cold-orphan reaper (admin only)",
        security: [{ SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      if (!adminAuth(req)) return reply.code(403).send({ error: "admin only" });
      reply.send(await ctx.engine.reapOrphans());
    },
  );

  r.post(
    "/v1/recent",
    {
      schema: {
        tags: ["memory"],
        summary: "List recent memories for the caller's scope",
        body: RecentBody.optional(),
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body ?? {};
      if (!(await checkProjectAccess(ctx, req.userId, body, reply))) return;
      reply.send(await ctx.engine.recent(req.userId, body));
    },
  );

  r.post(
    "/v1/neighbors",
    {
      schema: {
        tags: ["memory"],
        summary: "Graph-walk neighbours of a seed memory",
        body: NeighborsBody,
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!(await checkProjectAccess(ctx, req.userId, body, reply))) return;
      try {
        reply.send(await ctx.engine.neighbors(req.userId, body));
      } catch (err) {
        // Graph store occasionally returns Edge values the redis-client
        // decoder rejects ("Type mismatch: expected List or Null but was
        // Edge") — degrade to "no neighbours, graph degraded" so the SPA
        // still renders the seed inspector instead of a 500 modal.
        app.log?.warn?.({ err: (err as Error).message }, "[/v1/neighbors] degraded");
        reply.send({ seed: body.id, results: [], degraded: true });
      }
    },
  );

  r.post(
    "/v1/forget",
    {
      schema: {
        tags: ["memory"],
        summary: "Delete a memory entry by id",
        body: ForgetBody,
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!(await checkProjectAccess(ctx, req.userId, body, reply, false))) return;
      // Defence in depth: even after the requested-project check, resolve
      // the entry's actual scope by id alone and re-verify. Stops an
      // attacker who knows an entry id from deleting it by passing
      // `project: null` when the entry is project-scoped, or by passing a
      // project they're a member of when the entry actually belongs to a
      // different (non-member) project.
      if (ctx.warm) {
        const scope = await ctx.warm.getEntryScope(body.id);
        if (scope) {
          if (scope.projectId) {
            const m = await ctx.warm.getProjectMembership(scope.projectId, req.userId);
            if (!m) return reply.code(403).send({ error: "not a member of this project" });
          } else if (scope.userId !== req.userId) {
            return reply.code(403).send({ error: "entry not in your user namespace" });
          }
        }
      }
      reply.send(
        await ctx.engine.forget(req.userId, body.id, {
          project: body.project ?? null,
          token: req.bearerToken,
        }),
      );
    },
  );

  r.get(
    "/v1/stats",
    {
      schema: {
        tags: ["lifecycle"],
        summary: "Per-user counts across warm/cold/graph",
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      reply.send(await ctx.engine.stats(req.userId));
    },
  );
}
