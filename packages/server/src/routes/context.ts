/**
 * Shared types + helpers used across the route modules. The HTTP layer
 * was a 1300-LOC mega-function; split into per-group modules that each
 * receive this context plus the Fastify app instance.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { MemoryEngine } from "../engine/index.js";
import type { MetricsCollector } from "../admin/metrics.js";
import type { WarmStore } from "../warm-store/index.js";

export interface DashboardUser {
  id: string;
  username: string;
  role: "admin" | "user";
}

/** Per-account auth-attempt limiter — shared between the rotate-token
 *  handler and the Better Auth passthrough. Lives in RouteContext so the
 *  auth.ts module can register both surfaces. */
export interface AuthFailLimiter {
  /** Returns the locked entry when over the threshold, or undefined to
   *  proceed. Caller is responsible for sending the 429. */
  checkLocked: (key: string) => { count: number; resetAt: number } | undefined;
  recordFailure: (key: string) => void;
  clearFailure: (key: string) => void;
  send429: (reply: FastifyReply, e: { count: number; resetAt: number }) => void;
}

export interface BetterAuthBridge {
  handler: (req: Request) => Promise<Response>;
  getSession: (
    headers: Headers,
  ) => Promise<{ user?: { id: string }; session?: { id: string } } | null | undefined>;
}

export interface RouteContext {
  engine: MemoryEngine;
  warm?: WarmStore;
  metrics?: MetricsCollector;
  auth: { mode: "none" | "bearer" | "user"; token?: string };
  /** Master switch for /admin/* + /v1/admin/metrics. */
  adminDashboard: boolean;
  /** Browser Origin allowlist (echoed into per-route MCP guards). Same
   *  shape as `cfg.service.corsOrigins` — used for the spec-required
   *  Origin validation on /mcp* routes. */
  corsOrigins: readonly string[];
  /** Better Auth bridge — when set, /api/auth/* is mounted as a passthrough. */
  betterAuth?: BetterAuthBridge;
  /** Shared per-account auth-failure limiter (rotate-token + Better Auth). */
  authLimiter: AuthFailLimiter;
  /** Audit-log writer. No-ops when warm is undefined. Failures don't
   *  block the request. */
  audit: (
    req: FastifyRequest,
    action: string,
    target?: string | null,
    metadata?: Record<string, unknown>,
  ) => Promise<void>;
}

export type RouteRegistrar = (app: FastifyInstance, ctx: RouteContext) => void;

// ─── Shared helpers ────────────────────────────────────────────────────

/** Constant-time string compare — protects token-shaped material against
 *  timing oracles. Not for password hashes. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Centralised role check — also a type guard so call-sites get a
 *  narrowed `DashboardUser & { role: 'admin' }`. */
export function isAdmin(
  user: DashboardUser | undefined,
): user is DashboardUser & { role: "admin" } {
  return user?.role === "admin";
}

/** Admin gate for /v1/admin/* — requires a logged-in admin dashboard
 *  user. There is no operator-managed shared admin token; admin auth is
 *  always per-user. */
export function adminAuth(req: { dashUser?: DashboardUser }): boolean {
  return isAdmin(req.dashUser);
}

/** Resolve `req.dashUser` for handlers that require a logged-in user.
 *  Replies 401 + returns null when missing so the handler can `if (!u) return;`.
 *  Centralises what was a sprinkling of `req.dashUser!` non-null assertions. */
export function requireDashUser(
  req: FastifyRequest,
  reply: FastifyReply,
): DashboardUser | null {
  if (!req.dashUser) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return req.dashUser;
}

/** Resolve a single project reference (id or human name) to its real
 *  ULID, or null when nothing matches. */
export async function resolveProjectRef(
  ctx: RouteContext,
  userId: string,
  value: string,
): Promise<{ id: string; ownerUserId: string } | null> {
  if (!ctx.warm) return null;
  const byId = await ctx.warm.getProject(value);
  if (byId) return { id: byId.id, ownerUserId: byId.ownerUserId };
  const byName = await ctx.warm.findProjectByName(userId, value);
  if (byName) return { id: byName.id, ownerUserId: byName.ownerUserId };
  return null;
}

/** Resolve every project reference in the body (project + includeProjects)
 *  to a ULID, verify the caller is a member of each, and rewrite the body
 *  so downstream engine code sees only ULIDs. Distinguishes:
 *    - 404 "no such project" when the value matches neither id nor name
 *    - 403 "not a member" when the project exists but the caller isn't
 *      in its membership table
 *  Returns false when the request was rejected — handler should bail. */
export async function checkProjectAccess(
  ctx: RouteContext,
  userId: string,
  body: { project?: string | null; includeProjects?: string[] },
  reply: FastifyReply,
  /** When true (search/recent/neighbors), an unset scope defaults to
   *  `includeProjects: [activeProjectId]` so reads union user-global
   *  with the active project. When false (remember/forget), an unset
   *  scope defaults to `project: activeProjectId` so writes land in
   *  the active project. No-op if the user has no active project. */
  unionWithActive: boolean = true,
): Promise<boolean> {
  if (!ctx.warm) return true;
  const noScope =
    !body.project && (!body.includeProjects || body.includeProjects.length === 0);
  if (noScope) {
    const active = await ctx.warm.getActiveProject(userId);
    if (active) {
      if (unionWithActive) body.includeProjects = [active];
      else body.project = active;
    }
  }
  const refs: Array<{ field: "project" | "includeProjects"; index?: number; value: string }> = [];
  if (body.project) refs.push({ field: "project", value: body.project });
  body.includeProjects?.forEach((value, index) => {
    refs.push({ field: "includeProjects", index, value });
  });
  if (refs.length === 0) return true;
  for (const ref of refs) {
    const resolved = await resolveProjectRef(ctx, userId, ref.value);
    if (!resolved) {
      reply.code(404).send({
        error: `no such project '${ref.value}' — call project_list to see ids`,
      });
      return false;
    }
    const m = await ctx.warm.getProjectMembership(resolved.id, userId);
    if (!m) {
      reply.code(403).send({
        error: `not a member of project '${ref.value}' (id ${resolved.id})`,
      });
      return false;
    }
    if (ref.field === "project") body.project = resolved.id;
    else body.includeProjects![ref.index!] = resolved.id;
  }
  return true;
}
