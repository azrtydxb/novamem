/**
 * Fastify HTTP transport. App setup + plugins + auth hook + error handler;
 * routes are registered via the per-group modules under `routes/`.
 *
 * Module map:
 *   routes/data-plane.ts  — /v1/{search,remember,recent,neighbors,forget,
 *                              memories/:id,decay,dream-cycle,reap-orphans,stats}
 *   routes/me.ts          — /v1/me/* (genuinely user-scoped reads:
 *                              today, onboarding, metrics, projects,
 *                              tokens, active-project)
 *   routes/admin.ts       — /v1/admin/{tokens/revoke,audit-log,metrics,metrics/prom}
 *   routes/auth.ts        — /v1/auth/rotate-token + /api/auth/* passthrough
 *   routes/mcp-sse.ts     — /mcp/sse + /mcp/messages
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { z } from "zod";

import type { MemoryEngine } from "./engine/index.js";
import type { MetricsCollector } from "./admin/metrics.js";
import { openapiSpec } from "./openapi.js";
import { SYSTEM_USER, type WarmStore } from "./warm-store/index.js";
import type { Auth } from "./auth-betterauth.js";

/** Better Auth `getSession` return shape, derived directly from the
 *  configured BA instance's API surface. A BA version bump that changes
 *  the user/session payload becomes a compile error here instead of a
 *  silent runtime mismatch behind a structural cast. */
type BAGetSessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;

import {
  adminAuth,
  type AuthFailLimiter,
  type DashboardUser,
  type RouteContext,
  safeEqual,
} from "./routes/context.js";
import { register as registerDataPlane } from "./routes/data-plane.js";
import { register as registerMe } from "./routes/me.js";
import { register as registerAdmin } from "./routes/admin.js";
import { register as registerAuth } from "./routes/auth.js";
import { register as registerMcpSse } from "./routes/mcp-sse.js";

export type { DashboardUser } from "./routes/context.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved user for this request — populated by the auth hook.
     *  In `none` and `bearer` modes this is always `SYSTEM_USER`. */
    userId: string;
    /** Identity of the user bearer that authenticated this request — set
     *  in `user` auth mode after the bearer resolves. Used to attribute
     *  search/remember/forget calls to per-token metrics. */
    bearerToken?: { hash: string; label: string | null };
    /** Resolved dashboard user — populated by the dashboard auth hook for
     *  /v1/auth/* /v1/me/* /v1/admin/* /v1/decay routes when a session
     *  bearer is present. Undefined for data-plane requests authed by a
     *  user bearer. */
    dashUser?: DashboardUser;
  }
}

export interface HttpOptions {
  engine: MemoryEngine;
  /** Warm store — only used by the auth hook to resolve user bearers.
   *  Required when auth.mode = 'user'; optional otherwise. */
  warm?: WarmStore;
  auth: { mode: "none" | "bearer" | "user"; token?: string };
  /** Secret used to sign Fastify cookies. Sourced from `loadConfig()`
   *  (`NOVAMEM_COOKIE_SECRET`) so the server has a single canonical
   *  value. Optional in tests; required in production via the config
   *  layer's start-up check. */
  cookieSecret?: string;
  /** Per-IP requests-per-minute. Default 600 (10/sec sustained). */
  rateLimitPerMinute?: number;
  /** Pino log level. Sourced from `cfg.service.logLevel`. */
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  /** CORS allow-list. Sourced from `cfg.service.corsOrigins`. Empty array
   *  = same-origin only; ["*"] = reflect-any (legacy permissive). */
  corsOrigins?: string[];
  /** Metrics collector — when set, /v1/admin/metrics is available (subject
   *  to the dashboard flag below). When unset, the route 404s. */
  metrics?: MetricsCollector;
  /** Master switch for the admin dashboard surface (UI + metrics endpoint).
   *  When false, /admin/* and /v1/admin/metrics return 404. Default true. */
  adminDashboard?: boolean;
  /** Better Auth handler — when set, /api/auth/* is mounted as a
   *  passthrough into Better Auth (sign-in, sign-up, session, JWT, etc.).
   *  Optional during the migration so unit tests that don't touch
   *  dashboard auth can omit it. The auth hook also calls `getSession`
   *  on every request to populate `req.dashUser` from the Better Auth
   *  cookie/bearer. */
  betterAuth?: {
    handler: (req: Request) => Promise<Response>;
    getSession: (headers: Headers) => Promise<BAGetSessionResult>;
  };
}

export function buildHttpServer(opts: HttpOptions): FastifyInstance {
  // Fail-fast on misconfiguration — better to refuse to start than to 401
  // every request silently or, worse, to accept everything by accident.
  if (opts.auth.mode === "bearer" && !opts.auth.token) {
    throw new Error("auth.mode = 'bearer' requires auth.token to be set (NOVAMEM_AUTH_TOKEN)");
  }
  if (opts.auth.mode === "user") {
    if (!opts.warm) {
      throw new Error("auth.mode = 'user' requires the warm store to resolve user bearers");
    }
  }

  const app = Fastify({
    logger: {
      level: opts.logLevel ?? "info",
      // Never log Authorization headers, login passwords, or minted
      // token plaintexts. Pino's `redact` is field-path based; cover both
      // request-time fields and response shapes that pass through `req.log`.
      redact: {
        paths: [
          "req.headers.authorization",
          "request.headers.authorization",
          "headers.authorization",
          "*.authorization",
          'req.headers["x-admin-token"]',
          "req.body.password",
          "req.body.token",
          "req.body.tokenHash",
          "*.password",
          "*.passwordHash",
          "*.token",
          "*.plaintext",
        ],
        censor: "[REDACTED]",
        remove: false,
      },
    },
    bodyLimit: 2 * 1024 * 1024,
  });

  // Tighten CORS. `origin: true` reflects every Origin, which makes
  // the API a CSRF surface for any site that knows the URL. The allow-list
  // is parsed in `loadConfig()` from NOVAMEM_CORS_ORIGINS; here we just
  // map the resolved array onto Fastify-CORS' shape:
  //   undefined / []  → same-origin only (false)
  //   ["*"]           → reflect-any (true) — legacy permissive
  //   [origins…]      → exact allow-list
  const corsList = opts.corsOrigins;
  const corsOrigin: boolean | string[] =
    !corsList || corsList.length === 0
      ? false
      : corsList.length === 1 && corsList[0] === "*"
        ? true
        : corsList;
  app.register(cors, { origin: corsOrigin, credentials: corsOrigin !== false });

  // Cookie support for HttpOnly session storage. Cookies are
  // signed with a server-side secret so any bit-flip / tamper invalidates
  // the value before it reaches our auth hook.
  const cookieSecret = opts.cookieSecret ?? "novamem-dev-cookie-secret-change-me";
  app.register(fastifyCookie, { secret: cookieSecret });

  // ─── Global hardening headers (#47) ────────────────────────────────
  // Applied to every response. We deliberately do NOT set CSP globally —
  // the data plane is a JSON API, has no rendering surface, and a CSP
  // here would only collide with the per-route policies for /admin/* and
  // /api-docs/*. Per-route handlers that need a different X-Frame-Options
  // (none currently — we want DENY everywhere, including the Swagger UI
  // that's already locked down via `frame-ancestors 'none'`) can override
  // by calling `reply.header(…)` after `reply.send(…)` is queued.
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.getHeader("X-Content-Type-Options")) {
      reply.header("X-Content-Type-Options", "nosniff");
    }
    if (!reply.getHeader("Referrer-Policy")) {
      reply.header("Referrer-Policy", "no-referrer");
    }
    if (!reply.getHeader("X-Frame-Options")) {
      reply.header("X-Frame-Options", "DENY");
    }
    return payload;
  });

  // Standardised error body shape: {error, code?, issues?}. ZodError →
  // 400 with the issue list. For everything else we log the full error
  // server-side but only surface a generic message to the client — leaking
  // the raw Error (stack, file paths, lib versions) is an information-
  // disclosure vector (#46). Fastify HttpErrors with a 4xx statusCode are
  // already client-safe (e.g. validation, rate-limit) so we forward those
  // verbatim; 5xx and unknown errors collapse to a generic 500.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      reply.code(400).send({
        error: "invalid request body",
        issues: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
          code: i.code,
        })),
      });
      return;
    }
    req.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      reply.code(e.statusCode).send({ error: e.message || "request failed" });
      return;
    }
    reply.code(500).send({ error: "internal server error" });
  });

  // ─── OpenAPI + Swagger UI ──────────────────────────────────────────────
  app.register(fastifySwagger, {
    mode: "static",
    specification: { document: openapiSpec() as never },
  });
  // Swagger UI is publicly accessible. Combined with `tryItOutEnabled` +
  // `persistAuthorization` it would otherwise be a CSRF surface: a
  // malicious page could embed it in an iframe and ride a logged-in
  // user's session cookie. The exploitable vector is iframe embedding,
  // so we close it via `frame-ancestors 'none'` + a legacy
  // `X-Frame-Options: DENY` (set in the per-response onSend hook below,
  // which deliberately runs after this plugin's static CSP).
  //
  // `unsafe-inline` for style-src stays — Swagger UI ships its own
  // inline <style> tags and rewriting the bundle to use nonces is
  // disproportionate to the risk now that frame embedding is blocked.
  app.register(fastifySwaggerUi, {
    routePrefix: "/api-docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      tryItOutEnabled: true,
      persistAuthorization: true,
    },
    staticCSP: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:", "https:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "script-src": ["'self'"],
      "connect-src": ["'self'"],
      "font-src": ["'self'", "data:"],
      "frame-ancestors": ["'none'"],
    },
  });
  app.get("/openapi.json", async (_req, reply) => {
    reply.send(app.swagger());
  });
  app.register(rateLimit, {
    max: opts.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    skipOnError: true,
    allowList: (req) => req.url === "/health",
  });

  // ─── Per-account auth-attempt limiter ───────────────────────────────
  // Layered on top of the global per-IP limiter. Tracks failed attempts
  // per lower-cased account key (email for sign-in / change-password,
  // bearer-token prefix for rotate-token). 5 strikes inside a 15-minute
  // window → 429 with a Retry-After header until the window expires.
  const AUTH_FAIL_MAX = 5;
  const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
  type AuthFailEntry = { count: number; resetAt: number };
  const authFailures = new Map<string, AuthFailEntry>();
  function pruneAuthFailures(now: number): void {
    if (authFailures.size < 1024) return;
    for (const [k, v] of authFailures) if (v.resetAt <= now) authFailures.delete(k);
  }
  function getAuthFail(key: string, now: number): AuthFailEntry | undefined {
    const e = authFailures.get(key);
    if (!e) return undefined;
    if (e.resetAt <= now) {
      authFailures.delete(key);
      return undefined;
    }
    return e;
  }
  const authLimiter: AuthFailLimiter = {
    checkLocked(key) {
      const now = Date.now();
      const e = getAuthFail(key, now);
      if (e && e.count >= AUTH_FAIL_MAX) return e;
      return undefined;
    },
    recordFailure(key) {
      const now = Date.now();
      pruneAuthFailures(now);
      const existing = getAuthFail(key, now);
      if (existing) existing.count += 1;
      else authFailures.set(key, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
    },
    clearFailure(key) {
      authFailures.delete(key);
    },
    send429(reply: FastifyReply, e) {
      const retryAfter = Math.max(1, Math.ceil((e.resetAt - Date.now()) / 1000));
      reply
        .code(429)
        .header("Retry-After", String(retryAfter))
        .send({ error: "too many failed attempts — try again later", retryAfter });
    },
  };

  // ─── Auth hook ─────────────────────────────────────────────────────
  // Resolves either a user bearer (data plane) or a session bearer
  // (control plane). Public routes skip. Bearer prefixes:
  //   nm_<...>   user bearer (data plane)
  //   ns_<...>   dashboard session token (control plane; via Better Auth)
  //   anything else → `bearer`-mode shared token (only when auth.mode = 'bearer').
  //
  // Tightened admin-skip: only the SPA HTML entry points and the assets
  // prefix bypass the auth hook. Arbitrary /admin/<anything> would let an
  // unauthenticated caller probe non-existent paths without going through
  // the standard auth path.
  const ADMIN_PUBLIC_URLS = new Set(["/admin", "/admin/", "/admin/index.html"]);
  app.addHook("onRequest", async (req, reply) => {
    if (
      req.url === "/health" ||
      req.url === "/favicon.ico" ||
      req.url === "/openapi.json" ||
      req.url === "/api-docs" ||
      req.url.startsWith("/api-docs/") ||
      req.url.startsWith("/documentation/")
    ) {
      req.userId = SYSTEM_USER;
      return;
    }
    // Dashboard SPA — the HTML shell + hashed assets must load before login.
    // Tightened: only the explicit entry points + the assets directory.
    if (ADMIN_PUBLIC_URLS.has(req.url) || req.url.startsWith("/admin/assets/")) {
      req.userId = SYSTEM_USER;
      return;
    }
    // Better Auth handler — owns its own auth. Skip our hook so it gets
    // the raw request.
    if (req.url.startsWith("/api/auth/")) {
      req.userId = SYSTEM_USER;
      return;
    }
    // The CLI rotate-token path is reached without prior auth — the
    // route handler itself authenticates by trying to rotate the
    // supplied bearer.
    if (req.url === "/v1/auth/rotate-token") {
      req.userId = SYSTEM_USER;
      return;
    }

    // Resolve a Better Auth session if one is attached to this request.
    // Two routes produce a `dashUser`:
    //   1. Better Auth session — set by the SPA login flow.
    //   2. Our own user-bearer (`nm_…`) — non-browser callers (MCP, CLI)
    //      send these. Resolved against `user_tokens` below.
    const header = req.headers.authorization;
    const headerToken =
      header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (opts.betterAuth?.getSession) {
      const baHeaders = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") baHeaders.set(k, v);
        else if (Array.isArray(v)) baHeaders.set(k, v.join(", "));
      }
      try {
        const r = await opts.betterAuth.getSession(baHeaders);
        if (r?.user?.id) {
          req.dashUser = {
            id: r.user.id,
            // Better Auth has no `username` field — derive a displayable
            // one from the email's local-part. The dashboard already
            // treats "username" as cosmetic.
            username: (r.user as { email?: string }).email?.split("@")[0] ?? r.user.id,
            role: ((r.user as { role?: string }).role ?? "user") as "admin" | "user",
          };
        }
      } catch {
        // Better Auth throws on internal errors; treat as "no session"
        // and continue — the route guard below will 401 when needed.
      }
    }

    if (req.url.startsWith("/v1/auth/") || req.url.startsWith("/v1/me/")) {
      if (!req.dashUser && headerToken.startsWith("nm_") && opts.warm) {
        const resolved = await opts.warm.resolveUserToken(headerToken);
        if (resolved) {
          const u = await opts.warm.findUserById(resolved.userId);
          if (u) {
            req.dashUser = u as DashboardUser;
            req.bearerToken = { hash: resolved.tokenHash, label: resolved.label };
          }
        }
      }
      if (!req.dashUser) {
        reply.code(401).send({ error: "unauthorized" });
        return reply;
      }
      req.userId = req.dashUser.id;
      return;
    }

    // /v1/admin/* — handlers do their own check (session-admin only).
    // User id is irrelevant for admin routes.
    if (req.url.startsWith("/v1/admin/")) {
      req.userId = SYSTEM_USER;
      return;
    }

    // Data-plane (search/remember/forget/etc.). Three resolution paths:
    //   1. mode=none → SYSTEM_USER (open server).
    //   2. Session bearer attached (dashUser populated above) → that user.
    //      Lets the cookie-authed dashboard SPA hit /v1/* directly without
    //      a separate /v1/me/* mirror surface.
    //   3. mode=bearer → match the static shared token.
    //   4. mode=user → resolve the nm_… user bearer.
    if (req.dashUser) {
      req.userId = req.dashUser.id;
      return;
    }
    if (opts.auth.mode === "none") {
      req.userId = SYSTEM_USER;
      return;
    }
    if (!headerToken) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    if (opts.auth.mode === "bearer") {
      if (!safeEqual(headerToken, opts.auth.token!)) {
        reply.code(401).send({ error: "unauthorized" });
        return reply;
      }
      req.userId = SYSTEM_USER;
      return;
    }
    // user mode — resolve our nm_… user-bearer
    const resolved = await opts.warm!.resolveUserToken(headerToken);
    if (!resolved) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    req.userId = resolved.userId;
    req.bearerToken = { hash: resolved.tokenHash, label: resolved.label };
  });

  // ─── Admin dashboard (static SPA) ────────────────────────────────────
  // React + Vite bundle under packages/admin-ui. Mounted under /admin/*
  // with a strict CSP so even a stray inline-script attempt would fail
  // closed. The SPA authenticates with the HttpOnly session cookie set
  // at login. When the dashboard is disabled, we register no routes —
  // the server will 404 /admin and /admin/* automatically.
  if (opts.adminDashboard !== false) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "admin/ui"), // compiled: dist/http.js → dist/admin/ui
      resolve(here, "../../admin-ui/dist"), // dev: src/http.ts → packages/admin-ui/dist
    ];
    const uiRoot = candidates.find((p) => existsSync(p));
    if (!uiRoot) {
      app.log?.warn?.(
        "[novamem] admin dashboard enabled but UI assets not found — skipping static mount. Run `pnpm -r build` to build the UI.",
      );
    }
    if (uiRoot) {
      app.register(fastifyStatic, {
        root: uiRoot,
        prefix: "/admin/",
        setHeaders: (res) => {
          // `unsafe-inline` for style-src is intentional: Tailwind v4 +
          // React inline-style props produce inline <style>/style="…"
          // attributes that no static hash list can cover. The exploitable
          // vector (iframe embedding for clickjacking / CSRF) is closed
          // by `frame-ancestors 'none'` + the global `X-Frame-Options:
          // DENY` set by the onSend hook below.
          res.setHeader(
            "Content-Security-Policy",
            [
              "default-src 'self'",
              "img-src 'self' data:",
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self' data:",
              "script-src 'self'",
              "connect-src 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          );
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Referrer-Policy", "no-referrer");
        },
      });
      app.get("/admin", async (_req, reply) => reply.sendFile("index.html"));
      app.get("/admin/", async (_req, reply) => reply.sendFile("index.html"));
    }
  }

  // Public liveness/readiness probe. Exposes only `{ ok }` so an
  // unauthenticated caller cannot fingerprint the dep stack (Postgres,
  // Qdrant, FalkorDB) or read connection error details (#46). K8s probes
  // only need the boolean. Operators who want the per-dep snapshot
  // should hit /v1/admin/health/deep with a session-admin bearer.
  app.get("/health", async (_req, reply) => {
    const h = await opts.engine.health();
    reply.code(h.ok ? 200 : 503).send({ ok: h.ok });
  });

  // Admin-gated deep health: full per-dependency snapshot. Same status
  // semantics as /health (200 vs 503) but exposes the `deps` map.
  app.get("/v1/admin/health/deep", async (req, reply) => {
    if (!adminAuth(req)) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const h = await opts.engine.health();
    reply.code(h.ok ? 200 : 503).send(h);
  });

  // Browsers automatically request /favicon.ico from the page origin.
  app.get("/favicon.ico", async (_req, reply) => reply.code(204).send());

  // ─── Audit-log writer ──────────────────────────────────────────────
  // Failures don't block the request — audit gaps are preferable to
  // request 500s — but they get logged so operators notice.
  async function audit(
    req: FastifyRequest,
    action: string,
    target?: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!opts.warm) return;
    const actorLabel = req.dashUser ? `user:${req.dashUser.username}` : "unknown";
    try {
      await opts.warm.writeAudit({
        actorUserId: req.dashUser?.id ?? null,
        actorLabel,
        action,
        target: target ?? null,
        metadata,
        requestIp: req.ip ?? null,
      });
    } catch (err) {
      app.log.warn(`[audit] failed to record action=${action}: ${(err as Error).message}`);
    }
  }

  const ctx: RouteContext = {
    engine: opts.engine,
    warm: opts.warm,
    metrics: opts.metrics,
    auth: opts.auth,
    adminDashboard: opts.adminDashboard !== false,
    betterAuth: opts.betterAuth,
    authLimiter,
    audit,
  };

  // Order matters only for prefix overlaps; Fastify's router resolves
  // each path uniquely so it's mostly a readability concern.
  registerAuth(app, ctx);
  registerDataPlane(app, ctx);
  registerMe(app, ctx);
  registerAdmin(app, ctx);
  registerMcpSse(app, ctx);

  return app;
}
