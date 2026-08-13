/**
 * Admin routes: /v1/admin/{tokens/revoke,audit-log,metrics,metrics/prom}.
 * Gated by session-admin auth. Metrics endpoints additionally require
 * the dashboard flag (NOVAMEM_ADMIN_DASHBOARD).
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { AdminCreateUserBody, AdminRevokeBody } from "./schemas.js";
import { requireAdmin, type RouteContext } from "./context.js";

// Admin routes accept a session cookie (dashboard SPA) or an
// admin-owned nm_ user-bearer (non-interactive automation) — the auth
// hook resolves both into `dashUser`; requireAdmin enforces the role.
const AdminSecurity: ReadonlyArray<Record<string, readonly string[]>> = [
  { SessionCookie: [] },
  { UserBearer: [] },
];
const AuditLogQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
});

export function register(app: FastifyInstance, ctx: RouteContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/admin/tokens/revoke",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke a user bearer by plaintext token",
        body: AdminRevokeBody,
        security: AdminSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "admin disabled" });
      if (!requireAdmin(req, reply)) return;
      const ok = await ctx.warm.revokeUserToken(req.body.token);
      reply.send({ revoked: ok });
    },
  );

  r.post(
    "/v1/admin/users",
    {
      schema: {
        tags: ["admin"],
        summary: "Provision a user (and optionally a bearer token) non-interactively",
        body: AdminCreateUserBody,
        security: AdminSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "admin disabled" });
      const signUpEmail = ctx.betterAuth?.signUpEmail;
      if (!signUpEmail) {
        // No Better Auth mounted (auth.mode !== "user") — there is no
        // user table to provision into.
        return reply.code(404).send({ error: "user auth not enabled" });
      }
      if (!requireAdmin(req, reply)) return;
      const { email, password, name, tokenLabel, tokenScope, tokenExpiresInDays } = req.body;
      let userId: string | undefined;
      try {
        const r = await signUpEmail({
          email,
          password,
          // Same rationale as the bootstrap-admin sentinel: never default
          // `name` to the email — BA's name column is not unique, and an
          // email-shaped name enables lookup confusion.
          name: name ?? "provisioned-user",
        });
        userId = r?.user?.id;
      } catch (err) {
        // Better Auth throws APIError for policy failures; the only one
        // an admin can act on is a duplicate email.
        const msg = (err as Error).message ?? "sign-up failed";
        const status = (err as { statusCode?: number }).statusCode;
        return reply
          .code(status === 422 || /exist/i.test(msg) ? 409 : 400)
          .send({ error: msg });
      }
      if (!userId) return reply.code(500).send({ error: "sign-up returned no user id" });
      const minted = tokenLabel
        ? await ctx.warm.createUserToken(userId, tokenLabel, {
            scope: tokenScope ?? "full",
            expiresAt: tokenExpiresInDays
              ? new Date(Date.now() + tokenExpiresInDays * 86_400_000)
              : null,
          })
        : null;
      if (tokenLabel && !minted) {
        // createUserToken returns null when the user row isn't visible —
        // shouldn't happen for a user we just created, but a 201 without
        // the requested token would break the caller's contract.
        return reply
          .code(500)
          .send({ error: "user created but token mint failed", userId });
      }
      await ctx.audit(req, "admin.user.create", userId, {
        email,
        tokenMinted: minted !== null,
      });
      reply.code(201).send({
        userId,
        email,
        // Plaintext bearer — returned exactly once; the server stores
        // only its hash. Absent when no tokenLabel was requested.
        token: minted?.token,
      });
    },
  );

  r.get(
    "/v1/admin/audit-log",
    {
      schema: {
        tags: ["admin"],
        summary: "Tail the audit log",
        querystring: AuditLogQuery,
        security: AdminSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.warm) return reply.code(404).send({ error: "admin disabled" });
      if (!requireAdmin(req, reply)) return;
      const { limit } = req.query;
      reply.send({ entries: await ctx.warm.listAuditLog({ limit }) });
    },
  );

  r.get(
    "/v1/admin/metrics",
    {
      schema: {
        tags: ["admin"],
        summary: "Global metrics snapshot (JSON)",
        security: AdminSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.adminDashboard || !ctx.metrics) {
        return reply.code(404).send({ error: "admin disabled" });
      }
      if (!requireAdmin(req, reply)) return;
      reply.send(await ctx.metrics.snapshot());
    },
  );

  r.get(
    "/v1/admin/metrics/prom",
    {
      schema: {
        tags: ["admin"],
        summary: "Same metrics in Prometheus exposition format",
        security: AdminSecurity,
      },
    },
    async (req, reply) => {
      if (!ctx.adminDashboard || !ctx.metrics) {
        return reply.code(404).send({ error: "admin disabled" });
      }
      if (!requireAdmin(req, reply)) return;
      reply
        .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        .send(await ctx.metrics.renderProm());
    },
  );
}
