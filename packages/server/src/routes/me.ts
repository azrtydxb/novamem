/**
 * User self-service routes: /v1/me/* — genuinely user-scoped reads + the
 * project / active-project / token CRUD that has no /v1/* analogue.
 *
 * Every route attaches a zod schema; fastify-type-provider-zod runs
 * validation AND drives the OpenAPI document.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  ActiveProjectBody,
  AddMemberBody,
  CreateProjectBody,
  MeChangesQuery,
  MeExportQuery,
  MeImportBody,
  MintMyTokenBody,
} from "./schemas.js";
import {
  isAdmin,
  requireDashUser,
  resolveProjectRef,
  type RouteContext,
} from "./context.js";

const SessionSecurity: ReadonlyArray<Record<string, readonly string[]>> = [
  { SessionCookie: [] },
  { UserBearer: [] },
];
const ProjectIdParam = z.object({ id: z.string().min(1).max(128) });
const ProjectMemberParams = z.object({
  id: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
});
const TokenHashParam = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/i) });
const HistoryQuery = z.object({ hours: z.coerce.number().int().min(1).max(48).optional() });

export function register(app: FastifyInstance, ctx: RouteContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ─── User self-service: scoped metrics + own-user bearers ──────────────

  r.get(
    "/v1/me/metrics",
    {
      schema: {
        tags: ["metrics"],
        summary: "Per-caller throughput + lifetime counters (admins get the global view)",
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      const u = requireDashUser(req, reply);
      if (!u) return;
      if (!ctx.metrics) return reply.code(404).send({ error: "metrics disabled" });
      if (isAdmin(u)) {
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
    },
  );

  r.get(
    "/v1/me/metrics/history",
    {
      schema: {
        tags: ["metrics"],
        summary: "Rolling 1-48h sample history of queries + remembers",
        querystring: HistoryQuery,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "warm store disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const hours = req.query.hours ?? 24;
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
    },
  );

  r.get(
    "/v1/me/tokens",
    {
      schema: {
        tags: ["tokens"],
        summary: "List the caller's API tokens",
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "tokens disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      if (!u.id) return reply.code(400).send({ error: "user has no id assigned" });
      reply.send({ tokens: await ctx.warm.listUserTokens(u.id) });
    },
  );

  r.post(
    "/v1/me/tokens",
    {
      schema: {
        tags: ["tokens"],
        summary: "Mint a new `nm_…` API token for the caller",
        body: MintMyTokenBody.optional(),
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "tokens disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      if (!u.id) return reply.code(400).send({ error: "user has no id assigned" });
      const body = req.body ?? {};
      // A restricted bearer can't reach this route (the auth hook 403s
      // token mutations for it), so the caller here is a full-scope
      // credential and may mint any narrowing of itself.
      let projectId: string | null = null;
      if (body.project) {
        const resolved = await resolveProjectRef(ctx, u.id, body.project);
        if (!resolved) {
          return reply.code(404).send({
            error: `no such project '${body.project}' — call project_list to see ids`,
          });
        }
        const m = await ctx.warm.getProjectMembership(resolved.id, u.id);
        if (!m) {
          return reply.code(403).send({ error: `not a member of project '${body.project}'` });
        }
        projectId = resolved.id;
      }
      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 86_400_000)
        : null;
      const result = await ctx.warm.createUserToken(u.id, body.label, {
        scope: body.scope ?? "full",
        projectId,
        expiresAt,
      });
      if (!result) return reply.code(404).send({ error: "user missing" });
      reply.code(201).send({
        ...result,
        scope: body.scope ?? "full",
        projectId,
        expiresAt: expiresAt?.toISOString() ?? null,
        warning:
          "Store this token now — it will not be shown again. Server retains only a sha256 hash.",
      });
    },
  );

  r.delete(
    "/v1/me/tokens/:hash",
    {
      schema: {
        tags: ["tokens"],
        summary: "Hard-delete a token by its sha256 hash",
        params: TokenHashParam,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "tokens disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const { hash } = req.params;
      const ok = await ctx.warm.deleteUserTokenByHash(u.id, hash);
      if (!ok) return reply.code(404).send({ error: "token not found" });
      ctx.metrics?.forgetToken(hash);
      reply.send({ deleted: true });
    },
  );

  // ─── User self-service: projects (sub-brains) ──────────────────────────

  r.get(
    "/v1/me/projects",
    {
      schema: {
        tags: ["projects"],
        summary: "List projects the caller owns or is a member of",
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      reply.send({ projects: await ctx.warm.listProjectsForUser(u.id) });
    },
  );

  r.post(
    "/v1/me/projects",
    {
      schema: {
        tags: ["projects"],
        summary: "Create a project (sub-brain)",
        body: CreateProjectBody,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const body = req.body;
      const project = await ctx.warm.createProject({
        name: body.name,
        ownerUserId: u.id,
      });
      await ctx.audit(req, "project.create", project.id, { name: body.name });
      reply.code(201).send(project);
    },
  );

  r.delete(
    "/v1/me/projects/:id",
    {
      schema: {
        tags: ["projects"],
        summary: "Delete a project (owner only)",
        params: ProjectIdParam,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const { id: ref } = req.params;
      const resolved = await resolveProjectRef(ctx, u.id, ref);
      if (!resolved) return reply.code(404).send({ error: "unknown project" });
      if (resolved.ownerUserId !== u.id) {
        return reply.code(403).send({ error: "only the owner can delete a project" });
      }
      const r2 = await ctx.engine.deleteProject(resolved.id, resolved.ownerUserId);
      await ctx.audit(req, "project.delete", resolved.id, { entriesRemoved: r2.entriesRemoved });
      reply.send(r2);
    },
  );

  r.get(
    "/v1/me/projects/:id/members",
    {
      schema: {
        tags: ["projects"],
        summary: "List members of a project (member-only)",
        params: ProjectIdParam,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const { id: ref } = req.params;
      const resolved = await resolveProjectRef(ctx, u.id, ref);
      if (!resolved) return reply.code(404).send({ error: "unknown project" });
      const m = await ctx.warm.getProjectMembership(resolved.id, u.id);
      if (!m) return reply.code(403).send({ error: "not a member of this project" });
      reply.send({ members: await ctx.warm.listProjectMembers(resolved.id) });
    },
  );

  r.post(
    "/v1/me/projects/:id/members",
    {
      schema: {
        tags: ["projects"],
        summary: "Invite a user (by exact email) to a project (owner only)",
        params: ProjectIdParam,
        body: AddMemberBody,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const { id: ref } = req.params;
      const resolved = await resolveProjectRef(ctx, u.id, ref);
      if (!resolved) return reply.code(404).send({ error: "unknown project" });
      if (resolved.ownerUserId !== u.id) {
        return reply.code(403).send({ error: "only the owner can add members" });
      }
      const body = req.body;
      // Exact email only — `name`-based fuzzy matching here would let a
      // newly-registered attacker collide with a target's display name
      // and be invited in their place.
      const target = await ctx.warm.findUserByExactEmail(body.username);
      if (!target) return reply.code(404).send({ error: "unknown user" });
      const ok = await ctx.warm.addProjectMember(resolved.id, target.id, body.role ?? "member");
      if (!ok) return reply.code(409).send({ error: "user is already a member" });
      await ctx.audit(req, "project.member.add", resolved.id, {
        memberUserId: target.id,
        memberUsername: target.username,
        role: body.role ?? "member",
      });
      reply.code(201).send({ added: true, userId: target.id, username: target.username });
    },
  );

  r.delete(
    "/v1/me/projects/:id/members/:userId",
    {
      schema: {
        tags: ["projects"],
        summary: "Remove a member from a project (owner can remove anyone; members can leave)",
        params: ProjectMemberParams,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const { id: ref, userId } = req.params;
      const resolved = await resolveProjectRef(ctx, u.id, ref);
      if (!resolved) return reply.code(404).send({ error: "unknown project" });
      const isOwner = resolved.ownerUserId === u.id;
      if (!isOwner && userId !== u.id) {
        return reply.code(403).send({ error: "only the owner can remove other members" });
      }
      if (userId === resolved.ownerUserId) {
        return reply.code(400).send({ error: "owner cannot leave; delete the project instead" });
      }
      const r2 = await ctx.warm.removeProjectMember(resolved.id, userId);
      if (!r2.removed) return reply.code(404).send({ error: "user is not a member" });
      await ctx.audit(req, "project.member.remove", resolved.id, { memberUserId: userId });
      reply.send({ removed: true });
    },
  );

  // ─── Active project pointer ────────────────────────────────────────

  r.get(
    "/v1/me/active-project",
    {
      schema: {
        tags: ["self-service"],
        summary: "Get the caller's active project (or null)",
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const projectId = await ctx.warm.getActiveProject(u.id);
      if (!projectId) return reply.send({ active: null });
      const p = await ctx.warm.getProject(projectId);
      if (!p) {
        await ctx.warm.setActiveProject(u.id, null);
        return reply.send({ active: null });
      }
      const membership = await ctx.warm.getProjectMembership(projectId, u.id);
      if (!membership) {
        await ctx.warm.setActiveProject(u.id, null);
        return reply.send({ active: null });
      }
      reply.send({ active: { id: p.id, name: p.name } });
    },
  );

  r.put(
    "/v1/me/active-project",
    {
      schema: {
        tags: ["self-service"],
        summary: "Set the caller's active project",
        body: ActiveProjectBody,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const body = req.body;
      const resolved = await resolveProjectRef(ctx, u.id, body.project);
      if (!resolved) {
        return reply.code(404).send({ error: `no such project '${body.project}'` });
      }
      const m = await ctx.warm.getProjectMembership(resolved.id, u.id);
      if (!m) return reply.code(403).send({ error: "not a member of this project" });
      await ctx.warm.setActiveProject(u.id, resolved.id);
      reply.send({ active: { id: resolved.id } });
    },
  );

  r.delete(
    "/v1/me/active-project",
    {
      schema: {
        tags: ["self-service"],
        summary: "Clear the caller's active project",
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "projects disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      await ctx.warm.setActiveProject(u.id, null);
      reply.code(204).send();
    },
  );

  // ─── Today + onboarding (derived state for the SPA) ────────────────

  r.get(
    "/v1/me/export",
    {
      schema: {
        tags: ["self-service"],
        summary: "Keyset-paged export of every entry the caller owns",
        querystring: MeExportQuery,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "export disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const q = req.query ?? {};
      const entries = await ctx.warm.exportEntries(u.id, {
        afterId: q.afterId,
        limit: q.limit,
      });
      reply.send({
        entries,
        // Resume cursor: pass back as afterId until an empty page.
        nextAfterId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
      });
    },
  );

  r.post(
    "/v1/me/import",
    {
      schema: {
        tags: ["self-service"],
        summary: "Import entries (from an export or a migration) as new memories",
        body: MeImportBody,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "import disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      // Ids are NOT preserved: they are deployment-local ULIDs, and a
      // collision would silently graft foreign history onto a local row.
      // Content-hash dedup makes re-importing the same export idempotent.
      let imported = 0;
      let deduplicated = 0;
      const failed: Array<{ index: number; error: string }> = [];
      for (const [index, entry] of req.body.entries.entries()) {
        try {
          const r = await ctx.engine.remember(u.id, {
            content: entry.content,
            namespace: entry.namespace,
            source: entry.source ?? "import",
            agentName: entry.agentName,
            // Project references from a foreign deployment don't resolve
            // here; import lands user-wide unless the caller pre-created
            // the project and passes its local id/name.
            project: entry.project ?? null,
            metadata: entry.metadata,
            sourceType: entry.sourceType ?? "import",
            capturedFrom: entry.capturedFrom ?? "import",
            confidence: entry.confidence,
            force: true,
          }, req.bearerToken);
          if (r.deduplicated) deduplicated++;
          else if (r.id) imported++;
        } catch (err) {
          failed.push({ index, error: (err as Error).message });
        }
      }
      await ctx.audit(req, "user.import", u.id, {
        imported, deduplicated, failed: failed.length,
      });
      reply.code(failed.length === req.body.entries.length ? 400 : 201).send({
        imported, deduplicated, failed,
      });
    },
  );

  r.get(
    "/v1/me/usage",
    {
      schema: {
        tags: ["self-service"],
        summary: "The caller's stored-entry count and effective quotas",
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "usage disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const [entries, quota] = await Promise.all([
        ctx.warm.countEntriesForUser(u.id),
        ctx.warm.getUserQuota(u.id),
      ]);
      reply.send({ entries, quota });
    },
  );

  r.get(
    "/v1/me/changes",
    {
      schema: {
        tags: ["self-service"],
        summary: "Per-user memory changelog (created/updated/superseded/deleted/expired)",
        querystring: MeChangesQuery,
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "changes disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const q = req.query ?? {};
      const changes = await ctx.warm.listChanges(u.id, {
        since: q.since ? new Date(q.since) : undefined,
        afterSeq: q.afterSeq,
        limit: q.limit,
      });
      // `nextSeq` is the resume cursor: pass it back as afterSeq to page
      // forward without missing same-timestamp rows.
      reply.send({
        changes,
        nextSeq: changes.length > 0 ? changes[changes.length - 1]!.seq : (q.afterSeq ?? null),
      });
    },
  );

  r.get(
    "/v1/me/today",
    {
      schema: {
        tags: ["self-service"],
        summary: "Lightweight cross-table activity feed for the user dashboard",
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "warm store disabled" });
      const u = requireDashUser(req, reply);
      if (!u) return;
      const events = await ctx.warm.listRecentActivity(u.id, 50);
      reply.send({ events });
    },
  );

  r.get(
    "/v1/me/onboarding",
    {
      schema: {
        tags: ["self-service"],
        summary: "Derived onboarding state for the welcome wizard",
        security: SessionSecurity,
      },
    },
    async (req, reply) => {
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
    },
  );
}
