/**
 * User self-service routes: /v1/me/* — genuinely user-scoped reads + the
 * project / active-project / token CRUD that has no /v1/* analogue. The
 * data-plane mirrors that used to live here (search, remember, recent,
 * neighbors, forget, memories/:id) are gone; cookie-authed callers now hit
 * /v1/* directly because the auth hook resolves session bearers there too.
 */
import type { FastifyInstance } from "fastify";

import {
  ActiveProjectBody,
  AddMemberBody,
  CreateProjectBody,
  MintMyTokenBody,
} from "./schemas.js";
import {
  isAdmin,
  requireDashUser,
  resolveProjectRef,
  type RouteContext,
} from "./context.js";

export function register(app: FastifyInstance, ctx: RouteContext): void {
  // ─── User self-service: scoped metrics + own-user bearers ──────────────

  app.get("/v1/me/metrics", async (req, reply) => {
    const u = requireDashUser(req, reply);
    if (!u) return;
    if (!ctx.metrics) return reply.code(404).send({ error: "metrics disabled" });
    if (isAdmin(u)) {
      // Admins use /v1/admin/metrics; this endpoint exists for the user
      // dashboard. Redirect-by-content: return the global snapshot. Also
      // attach per-token series for the admin's own tokens so the
      // throughput chart on the admin Metrics page can break out
      // individual tokens too.
      const myTokens = ctx.warm
        ? (await ctx.warm.listTokensCreatedByUser(u.id)).map((t) => ({
            hash: t.tokenHash,
            label: t.label,
          }))
        : [];
      const global = await ctx.metrics.snapshot();
      const tokensByUser = new Map<string, Array<{ hash: string; label: string | null }>>();
      if (ctx.warm) {
        for (const row of await ctx.warm.listTokensCreatedByUser(u.id)) {
          const arr = tokensByUser.get(row.userId) ?? [];
          arr.push({ hash: row.tokenHash, label: row.label });
          tokensByUser.set(row.userId, arr);
        }
      }
      const tokenRows = [];
      for (const [userId, list] of tokensByUser) {
        const t = await ctx.metrics.snapshotForUser(userId, { tokens: list });
        if (t.tokens) tokenRows.push(...t.tokens);
      }
      return reply.send({ ...global, tokens: tokenRows, _hasMyTokens: myTokens.length > 0 });
    }
    if (!u.id) return reply.code(400).send({ error: "user has no id assigned" });
    const myTokens = ctx.warm
      ? (await ctx.warm.listTokensCreatedByUser(u.id))
          .filter((t) => t.userId === u.id)
          .map((t) => ({ hash: t.tokenHash, label: t.label }))
      : [];
    reply.send(await ctx.metrics.snapshotForUser(u.id, { tokens: myTokens }));
  });

  app.get("/v1/me/metrics/history", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "warm store disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const q = (req.query as { hours?: string } | undefined)?.hours;
    const hours = Math.min(48, Math.max(1, q ? Number(q) : 24));
    const since = Date.now() - hours * 60 * 60 * 1000;
    const samples = await ctx.warm.getMetricsHistory(u.id, since);
    reply.send({
      hours,
      samples: samples.map((s) => ({
        sampledAt: s.sampledAt.toISOString(),
        queries: s.queries,
        remembers: s.remembers,
      })),
    });
  });

  app.get("/v1/me/tokens", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    if (!u.id) return reply.code(400).send({ error: "user has no id assigned" });
    reply.send({ tokens: await ctx.warm.listUserTokens(u.id) });
  });

  app.post("/v1/me/tokens", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    if (!u.id) return reply.code(400).send({ error: "user has no id assigned" });
    const body = MintMyTokenBody.parse(req.body ?? {});
    const result = await ctx.warm.createUserToken(u.id, body.label);
    if (!result) return reply.code(404).send({ error: "user missing" });
    reply.code(201).send({
      ...result,
      warning: "Store this token now — it will not be shown again. Server retains only a sha256 hash.",
    });
  });

  /** Hard-delete a token by its sha256 hash. Removes the row outright
   *  (no soft "revoked" tombstone) so the list view doesn't accumulate
   *  dead entries. The device using it gets 401 on its next call. */
  app.delete("/v1/me/tokens/:hash", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const hash = (req.params as { hash: string }).hash;
    if (!/^[a-f0-9]{64}$/i.test(hash)) return reply.code(400).send({ error: "invalid hash" });
    const ok = await ctx.warm.deleteUserTokenByHash(u.id, hash);
    if (!ok) return reply.code(404).send({ error: "token not found" });
    ctx.metrics?.forgetToken(hash);
    reply.send({ deleted: true });
  });

  // ─── User self-service: projects (sub-brains) ──────────────────────────

  app.get("/v1/me/projects", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    reply.send({ projects: await ctx.warm.listProjectsForUser(u.id) });
  });

  app.post("/v1/me/projects", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const body = CreateProjectBody.parse(req.body);
    const project = await ctx.warm.createProject({
      name: body.name,
      ownerUserId: u.id,
    });
    await ctx.audit(req, "project.create", project.id, { name: body.name });
    reply.code(201).send(project);
  });

  app.delete("/v1/me/projects/:id", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const id = (req.params as { id: string }).id;
    const project = await ctx.warm.getProject(id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (project.ownerUserId !== u.id) {
      return reply.code(403).send({ error: "only the owner can delete a project" });
    }
    const r = await ctx.engine.deleteProject(id, project.ownerUserId);
    await ctx.audit(req, "project.delete", id, { entriesRemoved: r.entriesRemoved });
    reply.send(r);
  });

  app.get("/v1/me/projects/:id/members", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const id = (req.params as { id: string }).id;
    const m = await ctx.warm.getProjectMembership(id, u.id);
    if (!m) return reply.code(403).send({ error: "not a member of this project" });
    reply.send({ members: await ctx.warm.listProjectMembers(id) });
  });

  app.post("/v1/me/projects/:id/members", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const id = (req.params as { id: string }).id;
    const project = await ctx.warm.getProject(id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (project.ownerUserId !== u.id) {
      return reply.code(403).send({ error: "only the owner can add members" });
    }
    const body = AddMemberBody.parse(req.body);
    // Exact email only — `name`-based fuzzy matching here would let a
    // newly-registered attacker collide with a target's display name
    // and be invited in their place.
    const target = await ctx.warm.findUserByExactEmail(body.username);
    if (!target) return reply.code(404).send({ error: "unknown user" });
    const ok = await ctx.warm.addProjectMember(id, target.id, body.role ?? "member");
    if (!ok) return reply.code(409).send({ error: "user is already a member" });
    await ctx.audit(req, "project.member.add", id, {
      memberUserId: target.id,
      memberUsername: target.username,
      role: body.role ?? "member",
    });
    reply.code(201).send({ added: true, userId: target.id, username: target.username });
  });

  app.delete("/v1/me/projects/:id/members/:userId", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const { id, userId } = req.params as { id: string; userId: string };
    const project = await ctx.warm.getProject(id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const isOwner = project.ownerUserId === u.id;
    if (!isOwner && userId !== u.id) {
      return reply.code(403).send({ error: "only the owner can remove other members" });
    }
    if (userId === project.ownerUserId) {
      return reply.code(400).send({ error: "owner cannot leave; delete the project instead" });
    }
    const r = await ctx.warm.removeProjectMember(id, userId);
    if (!r.removed) return reply.code(404).send({ error: "user is not a member" });
    await ctx.audit(req, "project.member.remove", id, { memberUserId: userId });
    reply.send({ removed: true });
  });

  // ─── Active project pointer ────────────────────────────────────────

  app.get("/v1/me/active-project", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const projectId = await ctx.warm.getActiveProject(u.id);
    if (!projectId) return reply.send({ active: null });
    const p = await ctx.warm.getProject(projectId);
    if (!p) {
      // Stale pointer — clean up + return null.
      await ctx.warm.setActiveProject(u.id, null);
      return reply.send({ active: null });
    }
    reply.send({ active: { id: p.id, name: p.name } });
  });

  app.put("/v1/me/active-project", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const body = ActiveProjectBody.parse(req.body);
    const resolved = await resolveProjectRef(ctx, u.id, body.project);
    if (!resolved) {
      return reply.code(404).send({ error: `no such project '${body.project}'` });
    }
    const m = await ctx.warm.getProjectMembership(resolved.id, u.id);
    if (!m) return reply.code(403).send({ error: "not a member of this project" });
    await ctx.warm.setActiveProject(u.id, resolved.id);
    reply.send({ active: { id: resolved.id } });
  });

  app.delete("/v1/me/active-project", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    await ctx.warm.setActiveProject(u.id, null);
    reply.code(204).send();
  });

  // ─── Today + onboarding (derived state for the SPA) ────────────────

  /** Lightweight activity feed for the user dashboard. Derived from the
   *  recent memory_entries (kind = "remember") and recent user_tokens
   *  (kind = "token"). Cheap query, ranks by timestamp, capped at 50. */
  app.get("/v1/me/today", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "warm store disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const events = await ctx.warm.listRecentActivity(u.id, 50);
    reply.send({ events });
  });

  /** Onboarding state — derived, not stored. Tells the SPA which steps
   *  in the welcome wizard are done so it can highlight the next one. */
  app.get("/v1/me/onboarding", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "warm store disabled" });
    const u = requireDashUser(req, reply);
    if (!u) return;
    const userId = u.id;
    const tokens = await ctx.warm.listTokensCreatedByUser(u.id);
    const recent = u.id
      ? await ctx.engine.recent(u.id, { k: 1 })
      : { results: [] as unknown[] };
    reply.send({
      bootstrapDone: true,
      userExists: isAdmin(u) || !!u.id,
      mintedToken: tokens.length > 0,
      remembered: recent.results.length > 0,
      userId,
    });
  });
}
