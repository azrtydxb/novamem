/**
 * Shared types + helpers used across the route modules. The HTTP layer
 * was a 974-LOC mega-function; split into per-group modules that each
 * receive this context plus the Fastify app instance.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { MemoryEngine } from "../engine/index.js";
import type { MetricsCollector } from "../admin/metrics.js";
import type { LoginThrottle } from "../auth.js";
import type { WarmStore } from "../warm-store/index.js";

export interface DashboardUser {
  id: string;
  username: string;
  role: string;
  userId: string | null;
}

export interface RouteContext {
  engine: MemoryEngine;
  warm?: WarmStore;
  metrics?: MetricsCollector;
  auth: { mode: "none" | "bearer" | "user"; token?: string };
  /** Master switch for /admin/* + /v1/admin/metrics. */
  adminDashboard: boolean;
  /** In-memory per-username login throttle. */
  loginThrottle: LoginThrottle;
  /** Shared safe-equal — protects token compares against timing oracles. */
  safeEqual: (a: string, b: string) => boolean;
  /** Admin gate for /v1/admin/*. Requires a session-admin user. */
  adminAuth: (req: FastifyRequest) => boolean;
  /** Audit-log writer. No-ops when warm is undefined. Failures don't
   *  block the request. */
  audit: (
    req: FastifyRequest,
    action: string,
    target?: string | null,
    metadata?: Record<string, unknown>,
  ) => Promise<void>;
}

/** Resolve the project a request should be scoped to. Rules:
 *  - Project-scoped bearer: forced to that project. A different `project`
 *    in body → 403.
 *  - User-wide bearer (no project on token): user-wide entries only.
 *    A `project` in body → 403 ("mint a project-scoped token").
 *  Returns the project id (or null) on success, or undefined after
 *  sending a 403 reply. Centralised here so the rule cannot drift between
 *  the HTTP layer and the MCP layer (review finding P2-9). */
export function resolveRequestProject(
  req: { bearerProjectId?: string | null },
  bodyProject: string | null | undefined,
  reply: FastifyReply,
): string | null | undefined {
  const bearerProject = req.bearerProjectId ?? null;
  const requested = bodyProject === undefined ? null : bodyProject;
  if (bearerProject) {
    if (requested && requested !== bearerProject) {
      reply.code(403).send({
        error: `bearer is scoped to project '${bearerProject}'; cannot operate on '${requested}'`,
      });
      return undefined;
    }
    return bearerProject;
  }
  if (requested) {
    reply.code(403).send({
      error: "this bearer is user-wide; mint a project-scoped token to access a project",
    });
    return undefined;
  }
  return null;
}

/** Sentinel returned by reply helpers so handlers can `return errOf(reply, ...)`
 *  and bail out cleanly. Use the raw reply when you want to send + return. */
export type RouteRegistrar = (app: FastifyInstance, ctx: RouteContext) => void;
