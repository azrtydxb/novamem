/**
 * Admin routes: /v1/admin/{tokens/revoke,audit-log,metrics,metrics/prom}.
 * Gated by session-admin auth. Metrics endpoints additionally require
 * the dashboard flag (NOVAMEM_ADMIN_DASHBOARD).
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { AdminRevokeBody } from "./schemas.js";
import { adminAuth, type RouteContext } from "./context.js";

const AdminSecurity = [{ SessionCookie: [] as string[] }];
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
      if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
      const ok = await ctx.warm.revokeUserToken(req.body.token);
      reply.send({ revoked: ok });
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
      if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
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
      if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
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
      if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
      reply
        .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        .send(await ctx.metrics.renderProm());
    },
  );
}
