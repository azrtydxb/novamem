/**
 * Data-plane routes: /v1/{search,remember,recent,neighbors,forget,
 * memories/:id,decay,dream-cycle,reap-orphans,stats}.
 *
 * These were the largest cluster in the old http.ts mega-function. The
 * /v1/me/* mirrors that used to duplicate them are gone — the auth hook
 * now resolves Better Auth session bearers on the data-plane too, so the
 * cookie-authed dashboard can hit /v1/* directly.
 */
import type { FastifyInstance } from "fastify";

import {
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
  app.post("/v1/search", async (req, reply) => {
    const body = SearchBody.parse(req.body);
    if (!(await checkProjectAccess(ctx, req.userId, body, reply))) return;
    const r = await ctx.engine.search(req.userId, body, req.bearerToken);
    reply.send(r);
  });

  app.post("/v1/remember", async (req, reply) => {
    const body = RememberBody.parse(req.body);
    if (!(await checkProjectAccess(ctx, req.userId, body, reply, false))) return;
    const r = await ctx.engine.remember(req.userId, body, req.bearerToken);
    reply.code(201).send(r);
  });

  app.post("/v1/decay", async (req, reply) => {
    const body = DecayBody.parse(req.body ?? {});
    const r = await ctx.engine.decay({ effectiveDaysOverride: body.effectiveDays });
    reply.send(r);
  });

  app.post("/v1/dream-cycle", async (req, reply) => {
    // Manual trigger for the dedup-merge + edge-promotion pass. The same
    // logic runs daily via the timer in main.ts; this endpoint exists
    // for ad-hoc compaction (after a bulk import) and tests.
    // Admin-only (issue #45): scans memory across all users and is
    // expensive — non-admins must not be able to trigger it.
    if (!adminAuth(req)) return reply.code(403).send({ error: "admin only" });
    const r = await ctx.engine.dreamCycle();
    reply.send(r);
  });

  app.put("/v1/memories/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = UpdateMemoryBody.parse(req.body ?? {});
    if (!(await checkProjectAccess(ctx, req.userId, body, reply, false))) return;
    const r = await ctx.engine.update(req.userId, id, body);
    if (!r.updated) return reply.code(404).send({ error: "no such memory in your scope" });
    reply.send({ id, ...r });
  });

  app.post("/v1/reap-orphans", async (req, reply) => {
    // Manual trigger for the cold-orphan reaper. The same pass also runs
    // automatically inside the decay loop (main.ts). Cross-user by design.
    // Admin-only (issue #45): cross-user scan + DoS-class workload.
    if (!adminAuth(req)) return reply.code(403).send({ error: "admin only" });
    reply.send(await ctx.engine.reapOrphans());
  });

  app.post("/v1/recent", async (req, reply) => {
    const body = RecentBody.parse(req.body ?? {});
    if (!(await checkProjectAccess(ctx, req.userId, body, reply))) return;
    reply.send(await ctx.engine.recent(req.userId, body));
  });

  app.post("/v1/neighbors", async (req, reply) => {
    const body = NeighborsBody.parse(req.body);
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
  });

  app.post("/v1/forget", async (req, reply) => {
    const body = ForgetBody.parse(req.body);
    if (!(await checkProjectAccess(ctx, req.userId, body, reply, false))) return;
    // Defence in depth: even after the requested-project check, resolve
    // the entry's actual scope by id alone and re-verify. Stops an
    // attacker who knows an entry id from deleting it by passing
    // `project: null` when the entry is project-scoped, or by passing a
    // project they're a member of when the entry actually belongs to a
    // different (non-member) project. (Was previously only on
    // /v1/me/forget; promoted here so the protection is universal.)
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
  });

  app.get("/v1/stats", async (req, reply) => {
    reply.send(await ctx.engine.stats(req.userId));
  });

}
