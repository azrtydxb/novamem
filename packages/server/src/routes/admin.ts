/**
 * Admin routes: /v1/admin/{tokens/revoke,audit-log,metrics,metrics/prom}.
 * Gated by session-admin auth. Metrics endpoints additionally require
 * the dashboard flag (NOVAMEM_ADMIN_DASHBOARD).
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";

import { AdminRevokeBody } from "./schemas.js";
import { adminAuth, type RouteContext } from "./context.js";

export function register(app: FastifyInstance, ctx: RouteContext): void {
  app.post("/v1/admin/tokens/revoke", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const body = AdminRevokeBody.parse(req.body);
    const ok = await ctx.warm.revokeUserToken(body.token);
    reply.send({ revoked: ok });
  });

  // Audit log read (admin only).
  app.get("/v1/admin/audit-log", async (req, reply) => {
    if (!ctx.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    // Validate `?limit=` so non-numeric / negative / huge values reject
    // with a 400 instead of producing `LIMIT NaN` (500) or letting a
    // caller pull the entire table.
    const AuditLogQuery = z.object({
      limit: z.coerce.number().int().positive().max(500).default(200),
    });
    const { limit } = AuditLogQuery.parse(req.query ?? {});
    reply.send({ entries: await ctx.warm.listAuditLog({ limit }) });
  });

  // ─── Admin: operational metrics ──────────────────────────────────────
  // Read-through snapshot of in-process counters/gauges/rates. Gated by
  // session-admin auth AND the dashboard flag — operators who don't want
  // the surface set NOVAMEM_ADMIN_DASHBOARD=0 and the route disappears.
  app.get("/v1/admin/metrics", async (req, reply) => {
    if (!ctx.adminDashboard || !ctx.metrics) {
      return reply.code(404).send({ error: "admin disabled" });
    }
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    reply.send(await ctx.metrics.snapshot());
  });

  // Prometheus exposition format for scraping. Uses the same gauges +
  // counters as the JSON endpoint; admin-token gated so a public scraper
  // can't enumerate users/projects via the dashboard.
  app.get("/v1/admin/metrics/prom", async (req, reply) => {
    if (!ctx.adminDashboard || !ctx.metrics) {
      return reply.code(404).send({ error: "admin disabled" });
    }
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(await ctx.metrics.renderProm());
  });
}
