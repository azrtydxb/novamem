/**
 * Data-plane routes: /v1/{search,remember,recent,neighbors,forget,
 * memories/:id,decay,dream-cycle,reap-orphans,stats}.
 *
 * Each route attaches a zod schema via `schema: { body: … }`.
 * `fastify-type-provider-zod` runs validation at request time AND drives
 * the OpenAPI document — there is no separate spec to keep in sync.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  AdoptionBody,
  ContextBody,
  CaptureBody,
  DecayBody,
  EvaluateBody,
  ForgetBody,
  HygieneBody,
  NeighborsBody,
  RecentBody,
  RememberBody,
  SearchBody,
  SessionRecapBody,
  UpdateMemoryBody,
} from "./schemas.js";
import {
  requireOperator,
  checkProjectAccess,
  type RouteContext,
} from "./context.js";
import { buildAdoptionReport } from "../adoption.js";

export function register(app: FastifyInstance, ctx: RouteContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * "I found nothing" and "I could not look" are different claims, and a
   * 200 with `{results: [], degraded: true}` makes a client choose
   * between them by guessing. When a tier failed *and* nothing came back,
   * the response carries no evidence about the caller's memory at all, so
   * it is an error (503) — a client that retries or surfaces a warning is
   * behaving correctly, and one that concludes "no such memory" is not.
   *
   * Degraded *with* results stays a 200: those results are real, the
   * `degraded` flag says the set may be incomplete, and failing the
   * request would throw away answers we actually have.
   */
  const sendSearchResult = <T extends { results: unknown[]; degraded: boolean }>(
    reply: FastifyReply,
    result: T,
  ): void => {
    if (result.degraded && result.results.length === 0) {
      reply.code(503).send({
        ...result,
        error: "search degraded: a backing tier was unavailable and no results could be produced",
      });
      return;
    }
    reply.send(result);
  };




  /** Post-shape results for callers that rank first and hydrate later.
   *  Applied at the route layer so the engine's fusion (which needs full
   *  content for recency/entity signals and reranking) is untouched —
   *  only the wire payload shrinks. */
  const SNIPPET_CHARS = 240;
  const shapeContent = <T extends { results: unknown[] }>(
    result: T,
    mode: "full" | "snippet" | "ids" | undefined,
  ): T => {
    if (!mode || mode === "full") return result;
    for (const r of result.results as Array<Record<string, unknown>>) {
      const content = typeof r.content === "string" ? r.content : "";
      if (mode === "ids") {
        delete r.content;
        delete r.metadata;
      } else if (content.length > SNIPPET_CHARS) {
        const cut = content.slice(0, SNIPPET_CHARS);
        const lastSpace = cut.lastIndexOf(" ");
        r.content = (lastSpace > SNIPPET_CHARS / 2 ? cut.slice(0, lastSpace) : cut) + "\u2026";
        r.truncated = true;
      }
    }
    return result;
  };

  r.post(
    "/v1/adoption",
    {
      schema: {
        tags: ["memory"],
        summary: "Client adoption and refresh diagnostics for MCP/tooling integrations",
        body: AdoptionBody.optional(),
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body ?? {};
      reply.send(buildAdoptionReport(body));
    },
  );

  r.post(
    "/v1/hygiene",
    {
      schema: {
        tags: ["memory"],
        summary: "Read-only memory hygiene report",
        body: HygieneBody.optional(),
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body ?? {};
      reply.send(await ctx.engine.hygieneReport(req.userId, { k: body.k }));
    },
  );

  r.post(
    "/v1/evaluate",
    {
      schema: {
        tags: ["memory"],
        summary: "Run built-in memory quality evaluation scenarios",
        body: EvaluateBody.optional(),
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body ?? {};
      reply.send(await ctx.engine.evaluateMemoryQuality(req.userId, { suite: body.suite }));
    },
  );

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
      if (!(await checkProjectAccess(ctx, req, body, reply))) return;
      const result = await ctx.engine.search(req.userId, body, req.bearerToken);
      sendSearchResult(reply, shapeContent(result, body.contentMode));
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
      if (!(await checkProjectAccess(ctx, req, body, reply))) return;
      const k = body.k ?? 8;
      const relevant = await ctx.engine.search(req.userId, {
        query: body.message,
        k,
        namespace: body.namespace,
        includeNamespaces: body.includeNamespaces,
        project: body.project,
        includeProjects: body.includeProjects,
        weights: body.weights,
        maxSensitivity: body.maxSensitivity,
        // Prompt-assembly endpoint, so the token budget defaults ON —
        // see the ContextBody schema note.
        maxTokens: body.maxTokens ?? 6000,
      }, req.bearerToken);
      const recent = await ctx.engine.recent(req.userId, {
        k: Math.min(k, 10),
        namespace: body.namespace,
        includeNamespaces: body.includeNamespaces,
        project: body.project,
        includeProjects: body.includeProjects,
        maxSensitivity: body.maxSensitivity,
      });
      // Same rule as /v1/search and /v1/neighbors, and for the same reason:
      // this endpoint's whole job is to tell a caller what it knows, and
      // "I found nothing" is a different claim from "I could not look".
      // Returning 200 with an empty `relevant` while a tier was down invites
      // the caller to conclude the store is empty and to stop asking — the
      // guidance text below literally tells it to proceed. So a degraded
      // search that produced nothing is a 503 here too. Degraded WITH
      // results stays a 200: partial context is still useful, and the flag
      // rides along on `relevant` for a caller that wants to know.
      if (relevant.degraded && relevant.results.length === 0) {
        reply.code(503).send({
          relevant,
          recent,
          error: "context degraded: a backing tier was unavailable and no relevant memories could be produced",
        });
        return;
      }
      reply.send({
        relevant,
        recent,
        contextPack: ctx.engine.buildContextPack(relevant.results, recent.results),
        guidance: "Use this context before answering. Prefer contextPack sections over loose hits. For suggestion/recommendation/advice asks, DO answer: ground suggestions in the user's stored preferences, plans, and constraints from this context rather than declining or answering generically — measured on LongMemEval, declining these was the answerer's single largest error class. If the context holds nothing relevant about the user, say so briefly and give best general advice; never invent preferences. If relevant is empty, proceed but avoid asking the user to repeat context until targeted memory_search also misses.",
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
      if (!(await checkProjectAccess(ctx, req, body, reply, false))) return;
      const result = await ctx.engine.capture(req.userId, {
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
        sensitivity: body.sensitivity,
      }, req.bearerToken);
      reply.code(201).send(result);
    },
  );

  r.post(
    "/v1/session-recap",
    {
      schema: {
        tags: ["memory"],
        summary: "Ingest a concise session recap as typed durable memories",
        body: SessionRecapBody,
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!(await checkProjectAccess(ctx, req, body, reply, false))) return;
      const groups: Array<{ items?: string[]; namespace: string; memoryType: string }> = [
        { items: body.decisions, namespace: "decisions", memoryType: "decision" },
        { items: body.setupFacts, namespace: "current-setup", memoryType: "setup_fact" },
        { items: body.rootCauses, namespace: "root-causes", memoryType: "bug_root_cause" },
        { items: body.preferences, namespace: "user", memoryType: "user_preference" },
        { items: body.projectConventions, namespace: "project-conventions", memoryType: "project_convention" },
        { items: body.safetyConstraints, namespace: "safety", memoryType: "safety_constraint" },
        { items: body.other, namespace: body.namespace ?? "memory", memoryType: "general" },
      ];
      const results = [];
      for (const group of groups) {
        for (const content of group.items ?? []) {
          const r = await ctx.engine.capture(req.userId, {
            content,
            namespace: body.namespace ?? group.namespace,
            source: body.source ?? "memory_session_recap",
            agentName: body.agentName,
            project: body.project,
            metadata: { ...(body.metadata ?? {}), memoryType: group.memoryType, recap: true },
            sourceType: body.sourceType ?? "summary",
            capturedFrom: body.capturedFrom ?? "memory_session_recap",
            confidence: body.confidence,
            force: body.force,
            sensitivity: body.sensitivity,
          }, req.bearerToken);
          results.push(r);
        }
      }
      reply.code(201).send({ saved: results.filter((r) => r.id).length, results });
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
      if (!(await checkProjectAccess(ctx, req, body, reply, false))) return;
      const result = await ctx.engine.remember(req.userId, body, req.bearerToken);
      reply.code(201).send(result);
    },
  );

  // Arch-plan Phase 5: cacheable per-(user, project) observation prefix.
  // Returns the latest reflected log if the observer is enabled; otherwise
  // returns 404. Callers feed this into their LLM as a static prefix to
  // benefit from prompt caching, replacing dynamic retrieval for cost-
  // sensitive agents (Mastra OM pattern).
  r.get(
    "/v1/context-prefix",
    {
      schema: {
        tags: ["memory"],
        summary: "Cacheable observation log prefix for prompt-caching agents",
        querystring: z
          .object({
            project: z.string().max(128).optional().nullable(),
          })
          .optional(),
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      const prefix = await ctx.engine.getContextPrefix(
        req.userId,
        (req.query as { project?: string | null } | undefined)?.project ?? null,
      );
      if (prefix === null) return reply.code(404).send({ error: "observer disabled" });
      reply.send({ prefix });
    },
  );

  r.post(
    "/v1/observe",
    {
      schema: {
        tags: ["memory"],
        summary: "Trigger an observer+reflector pass over recent memories (operator)",
        body: z
          .object({
            project: z.string().max(128).optional().nullable(),
            limit: z.number().int().positive().max(200).optional(),
          })
          .optional(),
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      if (!requireOperator(ctx, req, reply)) return;
      const body = (req.body ?? {}) as { project?: string | null; limit?: number };
      const result = await ctx.engine.runObserver(req.userId, body.project ?? null, {
        limit: body.limit ?? 20,
      });
      if (result === null) return reply.code(503).send({ error: "observer disabled" });
      reply.send(result);
    },
  );

  r.post(
    "/v1/decay",
    {
      schema: {
        tags: ["lifecycle"],
        summary: "Trigger a decay sweep (operator)",
        body: DecayBody.optional(),
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      if (!requireOperator(ctx, req, reply)) return;
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
        summary: "Trigger the dedup-merge + edge-promotion pass (operator)",
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      if (!requireOperator(ctx, req, reply)) return;
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
      if (!(await checkProjectAccess(ctx, req, body, reply, false))) return;
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
        summary: "Trigger the cold-orphan reaper (operator)",
        security: [{ UserBearer: [] }, { SessionCookie: [] }],
      },
    },
    async (req, reply) => {
      if (!requireOperator(ctx, req, reply)) return;
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
      if (!(await checkProjectAccess(ctx, req, body, reply))) return;
      const recentResult = await ctx.engine.recent(req.userId, body);
      reply.send(shapeContent(recentResult, body.contentMode));
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
      if (!(await checkProjectAccess(ctx, req, body, reply))) return;
      try {
        sendSearchResult(reply, await ctx.engine.neighbors(req.userId, body));
      } catch (err) {
        // Graph store occasionally returns Edge values the redis-client
        // decoder rejects ("Type mismatch: expected List or Null but was
        // Edge") — degrade to "no neighbours, graph degraded" so the SPA
        // still renders the seed inspector instead of a 500 modal.
        app.log?.warn?.({ err: (err as Error).message }, "[/v1/neighbors] degraded");
        // Same rule as above: the walk failed and produced nothing, so the
        // caller learns nothing about this seed's neighbours. Say so.
        reply.code(503).send({
          seed: body.id,
          results: [],
          degraded: true,
          error: "neighbors degraded: graph traversal failed and no results could be produced",
        });
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
      if (!(await checkProjectAccess(ctx, req, body, reply, false))) return;
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
