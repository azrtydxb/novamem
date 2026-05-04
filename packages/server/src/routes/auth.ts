/**
 * Auth routes:
 *   POST /v1/auth/rotate-token   — user-bearer self-rotation (CLI / device path)
 *   ALL  /api/auth/*             — Better Auth passthrough (sign-in, sign-up,
 *                                    session, JWT, admin user-CRUD, etc.)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RouteContext } from "./context.js";

export function register(app: FastifyInstance, ctx: RouteContext): void {
  // ─── User bearer self-rotation (CLI / device path) ────────────────────
  // Holders of a user bearer (devices, CLIs) can rotate their own token
  // without needing admin access: present the current bearer, get a new
  // plaintext back (shown once), old one revoked atomically. Only meaningful
  // in user mode. Note: distinct from the dashboard's /v1/me/tokens —
  // this endpoint is for the *bearer* itself to roll over, the dashboard
  // is for user-facing CRUD.
  app.post("/v1/auth/rotate-token", async (req, reply) => {
    if (ctx.auth.mode !== "user" || !ctx.warm) {
      return reply.code(400).send({ error: "rotate-token is only available in user mode" });
    }
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const current = header.slice("Bearer ".length);
    // Per-account rate limiter: key on the presented bearer so a brute
    // force against one token doesn't burn the budget for unrelated
    // accounts. SHA-prefix the value so we never store the plaintext
    // bearer in the in-memory map.
    const { createHash } = await import("node:crypto");
    const limKey = `rotate:${createHash("sha256").update(current).digest("hex").slice(0, 32)}`;
    {
      const locked = ctx.authLimiter.checkLocked(limKey);
      if (locked) return ctx.authLimiter.send429(reply, locked);
    }
    const result = await ctx.warm.rotateUserToken(current);
    if (!result) {
      ctx.authLimiter.recordFailure(limKey);
      return reply.code(401).send({ error: "unauthorized" });
    }
    ctx.authLimiter.clearFailure(limKey);
    reply.code(201).send({
      ...result,
      warning: "Store this token now — it will not be shown again. The previous token is revoked.",
    });
  });

  // ─── Better Auth passthrough ────────────────────────────────────────
  // Better Auth speaks the WHATWG Request/Response interface; Fastify
  // gives us node req/res. We bridge by reconstructing a Request from
  // the incoming Fastify request, calling Better Auth's handler, and
  // copying the Response back. All HTTP methods on /api/auth/* go here.
  if (!ctx.betterAuth) return;
  const ba = ctx.betterAuth;

  /** Refuse operations that would leave the system with zero admins.
   *  Better Auth's admin plugin doesn't enforce this on its own —
   *  remove-user / set-role accept any target. We intercept the two
   *  paths that can drop the admin count and 400 when the target is
   *  the last surviving admin. */
  const guardLastAdmin = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (!ctx.warm || req.method !== "POST") return true;
    const path = req.url.split("?")[0] ?? "";
    const isRemove = path === "/api/auth/admin/remove-user";
    const isSetRole = path === "/api/auth/admin/set-role";
    if (!isRemove && !isSetRole) return true;
    const body = (req.body ?? {}) as { userId?: string; role?: string };
    const targetId = body.userId;
    if (!targetId) return true;
    // Demotion: only block when the new role is non-admin.
    if (isSetRole && body.role === "admin") return true;
    const r = await ctx.warm.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "user"
        WHERE role = 'admin' AND id <> $1`,
      [targetId],
    );
    const remainingAdmins = Number(r.rows[0]?.count ?? "0");
    if (remainingAdmins > 0) return true;
    const action = isRemove ? "delete" : "demote";
    reply.code(400).send({
      error: `cannot ${action} the last admin — promote another user first`,
      code: "LAST_ADMIN_PROTECTED",
    });
    return false;
  };

  /** Extract the account key for the per-account rate limiter on the two
   *  Better Auth endpoints we throttle. Returns null when the endpoint
   *  isn't rate-limited or no key is derivable from the request. */
  const authLimiterKey = (req: FastifyRequest): string | null => {
    if (req.method !== "POST") return null;
    const path = req.url.split("?")[0] ?? "";
    const body = (req.body ?? {}) as { email?: unknown; newPassword?: unknown };
    if (path === "/api/auth/sign-in/email") {
      return typeof body.email === "string" && body.email.length > 0
        ? `signin:${body.email.toLowerCase()}`
        : null;
    }
    if (path === "/api/auth/change-password") {
      // Change-password is session-authed; key on the dashUser id when
      // present (so an attacker can't grief by sending unauth'd requests
      // with arbitrary emails). Fall back to ip+path so anonymous spam
      // still gets capped via the same window.
      if (req.dashUser?.id) return `chgpw:${req.dashUser.id}`;
      return `chgpw-anon:${req.ip ?? "unknown"}`;
    }
    return null;
  };

  const passthrough = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await guardLastAdmin(req, reply))) return;
    const limKey = authLimiterKey(req);
    if (limKey) {
      const locked = ctx.authLimiter.checkLocked(limKey);
      if (locked) return ctx.authLimiter.send429(reply, locked);
    }
    // Build a WHATWG Request. Need the absolute URL, not just the
    // pathname; Better Auth uses it to validate redirects against
    // trustedOrigins. The host header is sufficient since the SPA and
    // backend share an origin.
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
    const host = req.headers.host ?? "localhost";
    const url = `${proto}://${host}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : req.body
          ? JSON.stringify(req.body)
          : undefined;
    const wReq = new Request(url, { method: req.method, headers, body });
    const wRes = await ba.handler(wReq);
    // Update the per-account limiter based on Better Auth's outcome.
    if (limKey) {
      if (wRes.status >= 200 && wRes.status < 300) {
        ctx.authLimiter.clearFailure(limKey);
      } else if (wRes.status >= 400 && wRes.status < 500) {
        ctx.authLimiter.recordFailure(limKey);
      }
    }
    // Copy status + headers + body back into the Fastify reply.
    // Set-Cookie is special: a Response can carry multiple values and
    // they MUST stay separate. `headers.forEach` collapses them with
    // commas, which browsers silently drop. `headers.getSetCookie()`
    // returns each cookie as its own array entry.
    reply.code(wRes.status);
    const setCookies = wRes.headers.getSetCookie();
    wRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      reply.header(key, value);
    });
    if (setCookies.length > 0) reply.header("set-cookie", setCookies);
    const text = await wRes.text();
    reply.send(text);
  };

  for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"] as const) {
    app.route({ method, url: "/api/auth/*", handler: passthrough });
  }
}
