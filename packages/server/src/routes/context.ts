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
  /** In-process sign-up — the only way to create a user without a browser.
   *  `/api/auth/sign-up/email` is intentionally not mounted over HTTP
   *  (issue #56); admin provisioning (`POST /v1/admin/users`) goes through
   *  this instead. Throws Better Auth's APIError on duplicate email etc. */
  signUpEmail?: (body: {
    email: string;
    password: string;
    name: string;
  }) => Promise<{ user?: { id?: string } } | null | undefined>;
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

/** Admin gate with correct HTTP semantics, shared by every admin-only
 *  route. `adminAuth` alone couldn't distinguish "no credentials" from
 *  "credentials without the admin role", so callers picked a code and
 *  drifted: /v1/admin/* answered 401 while /v1/decay answered 403 for the
 *  identical condition. Returns true when the caller may proceed;
 *  otherwise it has already sent 401 (unauthenticated) or 403
 *  (authenticated, not an admin). */
export function requireAdmin(
  req: { dashUser?: DashboardUser },
  reply: FastifyReply,
): boolean {
  if (!req.dashUser) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  if (!isAdmin(req.dashUser)) {
    reply.code(403).send({ error: "admin only" });
    return false;
  }
  return true;
}

/** Operator gate for the maintenance routes (decay, dream-cycle,
 *  reap-orphans, observer). In `user` auth mode these are admin-only —
 *  same rule as requireAdmin. In `bearer` mode there ARE no dashboard
 *  users: the whole server is guarded by one shared operator token, and
 *  any request that reached a handler already presented it (the global
 *  onRequest hook 401s otherwise) — so the token holder is the operator
 *  by definition, and gating on `dashUser` made these routes unreachable
 *  (the gap found running the Phase 3 gate: /v1/dream-cycle answered 401
 *  to the very token that could freely read and delete every memory).
 *  `none` mode is an open server; hiding maintenance behind a login that
 *  cannot exist protects nothing. */
export function requireOperator(
  ctx: { auth: { mode: "none" | "bearer" | "user" } },
  req: { dashUser?: DashboardUser },
  reply: FastifyReply,
): boolean {
  // A logged-in identity is always role-checked, whatever the auth mode —
  // issue #45's invariant: a non-admin dashboard user must not trigger
  // cross-user maintenance just because the server also allows anonymous
  // access.
  if (req.dashUser) return requireAdmin(req, reply);
  if (ctx.auth.mode !== "user") return true;
  return requireAdmin(req, reply);
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
  req: {
    userId: string;
    bearerToken?: { projectId: string | null };
  },
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
  const userId = req.userId;

  // Project-confined token: every data-plane call is forced into the
  // token's project. An explicit request for anything else is a 403 —
  // not silently rewritten, because a caller that asked for another
  // scope and got this one would misattribute what it reads and writes.
  // `body.project` alone (no includeProjects) is the engine's
  // "this project only" read scope, so confinement also excludes the
  // user-global store.
  const tokenProject = req.bearerToken?.projectId ?? null;
  if (tokenProject) {
    const explicit = [
      ...(body.project ? [body.project] : []),
      ...(body.includeProjects ?? []),
    ];
    for (const ref of explicit) {
      const resolved = await resolveProjectRef(ctx, userId, ref);
      if (!resolved || resolved.id !== tokenProject) {
        reply.code(403).send({
          error: "token is confined to its project",
        });
        return false;
      }
    }
    body.project = tokenProject;
    body.includeProjects = undefined;
    // Membership still checked below via the rewritten body — a token
    // whose user was since removed from the project must not pass.
    const m = await ctx.warm.getProjectMembership(tokenProject, userId);
    if (!m) {
      reply.code(403).send({ error: "not a member of the token's project" });
      return false;
    }
    return true;
  }
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
