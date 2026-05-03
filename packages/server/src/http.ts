/**
 * Fastify HTTP transport. Mirrors the engine API one-to-one with light
 * validation via Zod on the request bodies, plus an MCP/SSE bridge for
 * remote MCP-aware hosts.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

import type { MemoryEngine } from "./engine/index.js";
import type { MetricsCollector } from "./admin/metrics.js";
import {
  hashPassword,
  verifyPassword,
  SESSION_TTL_MS,
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  LoginThrottle,
  csrfCookieOptions,
  csrfRequired,
  generateCsrfToken,
  sessionCookieOptions,
} from "./auth.js";
import { buildMcpServer } from "./mcp.js";
import { openapiSpec } from "./openapi.js";
import { resolveRequestProject } from "./routes/context.js";
import {
  AddMemberBody,
  AdminCreateTenantBody,
  AdminCreateTokenBody,
  AdminRevokeBody,
  CreateProjectBody,
  CreateUserBody,
  DecayBody,
  ForgetBody,
  LoginBody,
  MintMyTokenBody,
  NeighborsBody,
  RecentBody,
  RememberBody,
  SearchBody,
  SetRoleBody,
} from "./routes/schemas.js";
import { PUBLIC_TENANT, type WarmStore } from "./warm-store/index.js";

export interface DashboardUser {
  id: string;
  username: string;
  role: string;
  tenantId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved tenant for this request — populated by the auth hook.
     *  In `none` and `bearer` modes this is always `PUBLIC_TENANT`. */
    tenantId: string;
    /** Project (sub-brain) the bearer is bound to. When set, requests
     *  default to this project; explicit `project` in body that mismatches
     *  is rejected by the engine layer. Null for tenant-wide tokens. */
    bearerProjectId?: string | null;
    /** Identity of the tenant token that authenticated this request — set
     *  in `tenant` auth mode after the bearer resolves. Used to attribute
     *  search/remember/forget calls to per-token metrics. */
    bearerToken?: { hash: string; label: string | null };
    /** Resolved dashboard user — populated by the dashboard auth hook for
     *  /v1/auth/* /v1/me/* /v1/admin/* /v1/decay routes when a session
     *  bearer is present. Undefined for data-plane requests authed by a
     *  tenant token. */
    dashUser?: DashboardUser;
  }
}

// Zod request-body schemas live in `routes/schemas.ts` so they can be
// imported by tests, the OpenAPI generator, and the MCP shim. See that
// file for the per-schema docstrings.

export interface HttpOptions {
  engine: MemoryEngine;
  /** Warm store — only used by the auth hook to resolve tenant tokens.
   *  Required when auth.mode = 'tenant'; optional otherwise. */
  warm?: WarmStore;
  auth: { mode: "none" | "bearer" | "tenant"; token?: string };
  /** Per-IP requests-per-minute. Default 600 (10/sec sustained). */
  rateLimitPerMinute?: number;
  /** Metrics collector — when set, /v1/admin/metrics is available (subject
   *  to the dashboard flag below). When unset, the route 404s. */
  metrics?: MetricsCollector;
  /** Master switch for the admin dashboard surface (UI + metrics endpoint).
   *  When false, /admin/* and /v1/admin/metrics return 404. Default true. */
  adminDashboard?: boolean;
}

export function buildHttpServer(opts: HttpOptions): FastifyInstance {
  // Fail-fast on misconfiguration — better to refuse to start than to 401
  // every request silently or, worse, to accept everything by accident.
  if (opts.auth.mode === "bearer" && !opts.auth.token) {
    throw new Error("auth.mode = 'bearer' requires auth.token to be set (NOVAMEM_AUTH_TOKEN)");
  }
  if (opts.auth.mode === "tenant") {
    if (!opts.warm) {
      throw new Error("auth.mode = 'tenant' requires the warm store to resolve tenant tokens");
    }
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // P1-S2: never log Authorization headers, login passwords, or minted
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

  // P1-S3: tighten CORS. `origin: true` reflects every Origin, which makes
  // the API a CSRF surface for any site that knows the URL. Operators can
  // override via NOVAMEM_CORS_ORIGINS (comma-separated allowlist) or set
  // the value `*` for the legacy permissive behaviour.
  const corsOriginsEnv = process.env.NOVAMEM_CORS_ORIGINS ?? "";
  const corsOrigin: boolean | string[] | RegExp =
    corsOriginsEnv === "" || corsOriginsEnv === "self"
      ? false // same-origin only — dashboard fetch from /admin works fine
      : corsOriginsEnv === "*"
        ? true
        : corsOriginsEnv.split(",").map((s) => s.trim()).filter(Boolean);
  app.register(cors, { origin: corsOrigin, credentials: corsOrigin !== false });

  // P1-S3: cookie support for HttpOnly session storage. Cookies are
  // signed with a server-side secret so any bit-flip / tamper invalidates
  // the value before it reaches our auth hook. NOVAMEM_COOKIE_SECRET is
  // operator-supplied in production; for dev we fall back to a fixed
  // string so restarts keep existing sessions valid.
  const cookieSecret =
    process.env.NOVAMEM_COOKIE_SECRET ?? "novamem-dev-cookie-secret-change-me";
  app.register(fastifyCookie, { secret: cookieSecret });

  // Per-username login throttle (P0-3). In-memory; resets on restart.
  const loginThrottle = new LoginThrottle();

  // P2-1: turn ZodError into a 400 with a helpful body, instead of the
  // default Fastify 500 with the raw error text. Other errors fall through
  // to Fastify's default handler.
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
    reply.send(err);
  });

  // ─── OpenAPI + Swagger UI ──────────────────────────────────────────────
  // Hand-written OpenAPI 3.0 doc (we don't auto-derive from Zod); served at
  // /openapi.json, with Swagger UI rendered at /api-docs. Both are public —
  // they're docs, not data — so they're added to the auth-hook skip list too.
  app.register(fastifySwagger, {
    mode: "static",
    specification: { document: openapiSpec() as never },
  });
  app.register(fastifySwaggerUi, {
    routePrefix: "/api-docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      tryItOutEnabled: true,
      persistAuthorization: true,
    },
    // Swagger UI bundles inline styles; relax style-src for this surface
    // (the dashboard's stricter CSP is unaffected). Scripts stay 'self'.
    staticCSP: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:", "https:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "script-src": ["'self'"],
      "connect-src": ["'self'"],
      "font-src": ["'self'", "data:"],
    },
  });
  // The plugin pair exposes the spec at /api-docs/json; we keep the
  // legacy /openapi.json path live for callers (and it's what the
  // dashboard's "API docs" link points at).
  app.get("/openapi.json", async (_req, reply) => {
    reply.send(app.swagger());
  });
  app.register(rateLimit, {
    max: opts.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    // Skip /health so liveness probes don't burn the budget.
    skipOnError: true,
    allowList: (req) => req.url === "/health",
  });

  /** Constant-time string compare — protects the admin token against
   *  timing oracles. Token-shaped material only; not for passwords. */
  function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return mismatch === 0;
  }

  // Auth hook — resolves either a tenant bearer (data plane) or a session
  // bearer (control plane). Public routes skip. Dashboard control-plane
  // routes (/v1/auth, /v1/me, /v1/admin) do their own RBAC checks inside
  // their handlers using `req.dashUser`.
  //
  // Bearer prefixes:
  //   nm_<...>   tenant token (data plane)
  //   ns_<...>   dashboard session token (control plane)
  //   anything else → `bearer`-mode shared token (only when auth.mode = 'bearer').
  app.addHook("onRequest", async (req, reply) => {
    if (
      req.url === "/health" ||
      req.url === "/favicon.ico" ||
      req.url === "/openapi.json" ||
      req.url === "/api-docs" ||
      req.url.startsWith("/api-docs/") ||
      req.url.startsWith("/documentation/")
    ) {
      req.tenantId = PUBLIC_TENANT;
      return;
    }
    // Dashboard static assets are public — HTML shell must load before login.
    if (req.url === "/admin" || req.url.startsWith("/admin/")) {
      req.tenantId = PUBLIC_TENANT;
      return;
    }
    // Login + bootstrap-status are reached without any auth. The CLI
    // rotate-token path is also public — it does its own auth by trying
    // to rotate the supplied bearer.
    if (
      req.url === "/v1/auth/login" ||
      req.url === "/v1/auth/status" ||
      req.url === "/v1/auth/rotate-token"
    ) {
      req.tenantId = PUBLIC_TENANT;
      return;
    }

    // Try to resolve a session bearer regardless of route — the control
    // plane handlers consult `req.dashUser` and admin endpoints require
    // a session-admin.
    //
    // Two ways to present a session: an HttpOnly cookie (the dashboard
    // SPA) or `Authorization: Bearer ns_…` (CLI / MCP / scripts). Cookie
    // takes precedence so a stale Authorization header doesn't override
    // a fresh cookie.
    const header = req.headers.authorization;
    const headerToken =
      header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    let token = headerToken;
    let authedByCookie = false;

    // Signed-cookie unsigning. `req.cookies[name]` is the raw signed
    // value; `req.unsignCookie` checks the signature. We use this to
    // detect tampering before resolving the bearer.
    const sessionCookieRaw = req.cookies?.[SESSION_COOKIE];
    if (sessionCookieRaw && opts.warm) {
      const unsigned = req.unsignCookie(sessionCookieRaw);
      if (unsigned.valid && unsigned.value && unsigned.value.startsWith("ns_")) {
        token = unsigned.value;
        authedByCookie = true;
      }
    }

    if (token.startsWith("ns_") && opts.warm) {
      const session = await opts.warm.resolveSession(token);
      if (session) req.dashUser = session.user;
    }

    // CSRF double-submit: when the request is authed by cookie AND the
    // method is state-changing, the X-CSRF-Token header must equal the
    // CSRF cookie. Bearer-authenticated requests skip this check (they
    // aren't browser-vector). The CSRF cookie is signed too, so a
    // tampered value gets ignored before we compare.
    if (req.dashUser && authedByCookie && csrfRequired(req.method)) {
      // Plain double-submit: header must equal cookie. The cookie is
      // SameSite=Strict so cross-site requests can't carry it; that
      // already blocks classic CSRF. The header check makes XSS-via-
      // arbitrary-form-post (which can attach cookies but not headers)
      // impractical. We don't sign this cookie because the SPA needs to
      // echo the raw value back, and there's no benefit to signing a
      // value that's already in the same channel both ways.
      const csrfHeader = (req.headers[CSRF_HEADER] as string | undefined) ?? "";
      const csrfCookieValue = req.cookies?.[CSRF_COOKIE] ?? "";
      if (!csrfHeader || !csrfCookieValue || !safeEqual(csrfHeader, csrfCookieValue)) {
        reply.code(403).send({ error: "CSRF token missing or invalid" });
        return reply;
      }
    }

    // /v1/auth/* (other than login/status) and /v1/me/* require a session.
    if (req.url.startsWith("/v1/auth/") || req.url.startsWith("/v1/me/")) {
      if (!req.dashUser) {
        reply.code(401).send({ error: "unauthorized" });
        return reply;
      }
      req.tenantId = req.dashUser.tenantId ?? PUBLIC_TENANT;
      return;
    }

    // /v1/admin/* — handlers do their own check (session-admin only).
    // Tenant id is irrelevant for admin routes.
    if (req.url.startsWith("/v1/admin/")) {
      req.tenantId = PUBLIC_TENANT;
      return;
    }

    // Data-plane (search/remember/forget/etc.) — tenant bearer required
    // unless mode = none/bearer.
    if (opts.auth.mode === "none") {
      req.tenantId = PUBLIC_TENANT;
      return;
    }
    if (!token) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    if (opts.auth.mode === "bearer") {
      if (!safeEqual(token, opts.auth.token!)) {
        reply.code(401).send({ error: "unauthorized" });
        return reply;
      }
      req.tenantId = PUBLIC_TENANT;
      return;
    }
    // tenant mode
    const resolved = await opts.warm!.resolveTenantToken(token);
    if (!resolved) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    req.tenantId = resolved.tenantId;
    req.bearerProjectId = resolved.projectId;
    req.bearerToken = { hash: resolved.tokenHash, label: resolved.label };
  });

  // ─── Admin dashboard (static SPA) ────────────────────────────────────
  // React + Vite bundle under packages/admin-ui. Mounted under /admin/*
  // with a strict CSP so even a stray inline-script attempt would fail
  // closed. The SPA authenticates with the HttpOnly session cookie set
  // at login. When the dashboard is disabled, we register no routes —
  // the server will 404 /admin and /admin/* automatically.
  if (opts.adminDashboard !== false) {
    // The admin SPA is built by the @azrty/novamem-admin-ui package and copied
    // into this server's dist/admin/ui by the build:assets step. In dev (tsx
    // watch) we read the admin-ui's dist directly. Probe both layouts; if
    // neither exists, skip the mount so unit tests and dev runs without the
    // UI built still start cleanly.
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
      // Strict CSP: only same-origin scripts/styles/fetches. The SPA pulls
      // its vendored Preact + htm from the same origin, so this works.
      setHeaders: (res) => {
        // Self-only policy. `style-src 'unsafe-inline'` is required for
        // styled-components / Vite-generated runtime style nodes (and is
        // also acceptable for an admin-only surface). Fonts are bundled
        // (woff2 served from /admin/assets/) so no external font hosts.
        res.setHeader(
          "Content-Security-Policy",
          [
            "default-src 'self'",
            "img-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self' data:",
            "script-src 'self'",
            "connect-src 'self'",
          ].join("; "),
        );
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
      },
    });
    // SPA fallback: GET /admin and GET /admin/ both serve index.html. The
    // wildcard would be nicer but the SPA only has one entry point so the
    // explicit pair is enough and avoids clobbering /admin/assets/*.
    app.get("/admin", async (_req, reply) => reply.sendFile("index.html"));
    app.get("/admin/", async (_req, reply) => reply.sendFile("index.html"));
    }
  }

  app.get("/health", async (_req, reply) => {
    const h = await opts.engine.health();
    reply.code(h.ok ? 200 : 503).send(h);
  });

  // Browsers automatically request /favicon.ico from the page origin. Without
  // a handler it 404s after going through the auth hook (which we already
  // skip for this URL); explicit empty-204 keeps console clean.
  app.get("/favicon.ico", async (_req, reply) => reply.code(204).send());

  app.post("/v1/search", async (req, reply) => {
    const body = SearchBody.parse(req.body);
    const project = resolveRequestProject(req, body.project ?? null, reply);
    if (project === undefined) return reply;
    const r = await opts.engine.search(req.tenantId, { ...body, project }, req.bearerToken);
    reply.send(r);
  });

  app.post("/v1/remember", async (req, reply) => {
    const body = RememberBody.parse(req.body);
    const project = resolveRequestProject(req, body.project ?? null, reply);
    if (project === undefined) return reply;
    const r = await opts.engine.remember(req.tenantId, { ...body, project }, req.bearerToken);
    reply.code(201).send(r);
  });

  app.post("/v1/decay", async (req, reply) => {
    const body = DecayBody.parse(req.body ?? {});
    const r = await opts.engine.decay({ effectiveDaysOverride: body.effectiveDays });
    reply.send(r);
  });

  app.post("/v1/reap-orphans", async (_req, reply) => {
    // Manual trigger for the cold-orphan reaper. The same pass also runs
    // automatically inside the decay loop (main.ts). Cross-tenant by design —
    // each orphan row carries its own tenant_id.
    reply.send(await opts.engine.reapOrphans());
  });

  app.post("/v1/recent", async (req, reply) => {
    const body = RecentBody.parse(req.body ?? {});
    const project = resolveRequestProject(req, body.project ?? null, reply);
    if (project === undefined) return reply;
    reply.send(await opts.engine.recent(req.tenantId, { ...body, project }));
  });

  app.post("/v1/neighbors", async (req, reply) => {
    const body = NeighborsBody.parse(req.body);
    const project = resolveRequestProject(req, body.project ?? null, reply);
    if (project === undefined) return reply;
    reply.send(await opts.engine.neighbors(req.tenantId, { ...body, project }));
  });

  app.post("/v1/forget", async (req, reply) => {
    const body = ForgetBody.parse(req.body);
    const project = resolveRequestProject(req, body.project ?? null, reply);
    if (project === undefined) return reply;
    reply.send(
      await opts.engine.forget(req.tenantId, body.id, { project, token: req.bearerToken }),
    );
  });

  app.get("/v1/stats", async (req, reply) => {
    reply.send(await opts.engine.stats(req.tenantId));
  });

  // ─── Admin: tenant + token bootstrap ──────────────────────────────────
  // Available in any auth mode (so you can seed tenants before flipping
  // the service into 'tenant' mode), but if mode != 'tenant' the warm
  // store may not be configured — handlers hard-require it.

  /** Admin gate for /v1/admin/*. Requires a logged-in admin dashboard
   *  user — log in via /v1/auth/login first, then the cookie or session
   *  bearer carries the role through. There is no operator-managed
   *  shared admin token; admin auth is always per-user. */
  const adminAuth = (req: { dashUser?: DashboardUser }): boolean => {
    return req.dashUser?.role === "admin";
  };

  /** Write an audit entry attributed to the current request's actor.
   *  Failures don't block the request — audit gaps are preferable to
   *  request 500s — but they get logged so operators notice. */
  async function audit(
    req: { dashUser?: DashboardUser; ip?: string; headers: { authorization?: string } },
    action: string,
    target?: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!opts.warm) return;
    const actorLabel = req.dashUser
      ? `user:${req.dashUser.username}`
      : "legacy-admin-token";
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

  // ─── Dashboard auth ────────────────────────────────────────────────────

  app.get("/v1/auth/status", async (_req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "auth disabled" });
    const adminCount = await opts.warm.countAdmins();
    reply.send({
      ready: adminCount > 0,
      bootstrapNeeded: adminCount === 0,
    });
  });

  app.post("/v1/auth/login", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "auth disabled" });
    const body = LoginBody.parse(req.body);

    // P0-3: per-username login throttle. Refuse without spending bcrypt
    // CPU when the account is locked out.
    const throttleState = loginThrottle.check(body.username);
    if (!throttleState.ok) {
      reply.header("Retry-After", String(Math.ceil(throttleState.retryAfterMs / 1000)));
      return reply.code(429).send({
        error: "too many failed login attempts; account temporarily locked",
        retryAfterMs: throttleState.retryAfterMs,
      });
    }

    const user = await opts.warm.findUserByUsername(body.username);
    // Constant-ish-time: always run a verifyPassword against something to
    // avoid leaking whether the username exists. We compare against a
    // throwaway hash when the user is missing.
    const ok = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyPassword(body.password, "$2a$10$invalidsaltinvalidsaltinvalidsaltinvalid");
    if (!user || !ok) {
      const fail = loginThrottle.recordFailure(body.username);
      // Sleep for the back-off interval inside the handler so a fast
      // attacker can't out-loop the throttle.
      if (fail.retryAfterMs > 0) {
        await new Promise((r) => setTimeout(r, Math.min(fail.retryAfterMs, 4000)));
      }
      return reply.code(401).send({ error: "invalid username or password" });
    }
    loginThrottle.recordSuccess(body.username);
    const session = await opts.warm.createSession(user.id, SESSION_TTL_MS);
    // P1-S3: dashboard sessions live in HttpOnly + Secure + SameSite=Strict
    // cookies. The CSRF token sits in a sibling JS-readable cookie; the
    // SPA reads it and echoes back as X-CSRF-Token on writes.
    const csrf = generateCsrfToken();
    reply
      .setCookie(SESSION_COOKIE, session.token, {
        ...sessionCookieOptions(),
        signed: true,
      })
      .setCookie(CSRF_COOKIE, csrf, csrfCookieOptions())
      .code(201)
      .send({
        // We still return `token` in the body for back-compat with the
        // CLI / MCP flow (novamem-login etc.); browsers don't need to read
        // it because the cookie is set.
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        csrfToken: csrf,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          tenantId: user.tenantId,
        },
      });
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    // Revoke the session server-side regardless of how it was presented.
    let token = "";
    const cookieRaw = req.cookies?.[SESSION_COOKIE];
    if (cookieRaw) {
      const unsigned = req.unsignCookie(cookieRaw);
      if (unsigned.valid && unsigned.value) token = unsigned.value;
    }
    if (!token) {
      const h = req.headers.authorization;
      if (h && h.startsWith("Bearer ")) token = h.slice("Bearer ".length);
    }
    if (opts.warm && token) await opts.warm.revokeSession(token);
    // Clear both cookies so the browser stops sending them.
    reply
      .clearCookie(SESSION_COOKIE, { path: "/" })
      .clearCookie(CSRF_COOKIE, { path: "/" })
      .code(204)
      .send();
  });

  app.get("/v1/auth/me", async (req, reply) => {
    // Auth hook already resolved the session; if we got here it's valid.
    // Re-issue the CSRF cookie on every me() so the SPA always has a fresh
    // value after page reload (the JS-readable cookie persists across
    // reloads but having `me()` re-issue it makes the flow more robust).
    const csrf = generateCsrfToken();
    reply
      .setCookie(CSRF_COOKIE, csrf, csrfCookieOptions())
      .send({ user: req.dashUser, csrfToken: csrf });
  });

  // ─── Admin: user management ────────────────────────────────────────────
  // Distinct from /v1/admin/tenants/* — these are dashboard logins.
  // Only a logged-in admin can manage them.

  app.get("/v1/admin/users", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    reply.send({ users: await opts.warm.listUsers() });
  });

  app.post("/v1/admin/users", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const body = CreateUserBody.parse(req.body);
    const existing = await opts.warm.findUserByUsername(body.username);
    if (existing) return reply.code(409).send({ error: "username already exists" });
    if (body.role === "user" && body.tenantId) {
      const tenants = await opts.warm.listTenants();
      if (!tenants.find((t) => t.id === body.tenantId)) {
        return reply.code(400).send({ error: "unknown tenantId" });
      }
    }
    const hash = await hashPassword(body.password);
    const user = await opts.warm.createUser({
      username: body.username,
      passwordHash: hash,
      role: body.role,
      tenantId: body.role === "admin" ? null : (body.tenantId ?? null),
    });
    await audit(req, "user.create", user.id, {
      username: body.username,
      role: body.role,
      tenantId: body.role === "admin" ? null : body.tenantId,
    });
    reply.code(201).send(user);
  });

  app.delete("/v1/admin/users/:id", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const id = (req.params as { id: string }).id;
    // Refuse self-deletion: prevents an admin from accidentally locking
    // themselves out (and would also mid-request invalidate their session).
    if (req.dashUser?.id === id) {
      return reply.code(400).send({ error: "cannot delete yourself" });
    }
    // Refuse to delete the last admin so the dashboard never becomes
    // unmanageable.
    const target = await opts.warm.findUserById(id);
    if (!target) return reply.code(404).send({ error: "unknown user" });
    if (target.role === "admin") {
      const adminCount = await opts.warm.countAdmins();
      if (adminCount <= 1) {
        return reply.code(400).send({ error: "cannot delete the last admin" });
      }
    }
    const ok = await opts.warm.deleteUser(id);
    if (ok) await audit(req, "user.delete", id, { username: target.username });
    reply.send({ deleted: ok });
  });

  app.post("/v1/admin/users/:id/role", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const id = (req.params as { id: string }).id;
    const body = SetRoleBody.parse(req.body);
    const target = await opts.warm.findUserById(id);
    if (!target) return reply.code(404).send({ error: "unknown user" });
    // Don't strip the last admin role.
    if (target.role === "admin" && body.role !== "admin") {
      const adminCount = await opts.warm.countAdmins();
      if (adminCount <= 1) {
        return reply.code(400).send({ error: "cannot demote the last admin" });
      }
    }
    if (body.role === "user" && body.tenantId) {
      const tenants = await opts.warm.listTenants();
      if (!tenants.find((t) => t.id === body.tenantId)) {
        return reply.code(400).send({ error: "unknown tenantId" });
      }
    }
    const ok = await opts.warm.setUserRole(
      id,
      body.role,
      body.role === "admin" ? null : (body.tenantId ?? null),
    );
    if (ok)
      await audit(req, "user.role.change", id, {
        previousRole: target.role,
        newRole: body.role,
        tenantId: body.role === "admin" ? null : body.tenantId,
      });
    reply.send({ updated: ok });
  });

  // ─── User self-service: scoped metrics + own-tenant tokens ─────────────

  app.get("/v1/me/metrics", async (req, reply) => {
    const u = req.dashUser!;
    if (!opts.metrics) return reply.code(404).send({ error: "metrics disabled" });
    if (u.role === "admin") {
      // Admins use /v1/admin/metrics; this endpoint exists for the user
      // dashboard. Redirect-by-content: return the global snapshot. Also
      // attach per-token series for the admin's own tokens so the
      // throughput chart on the admin Metrics page can break out
      // individual tokens too.
      const myTokens = opts.warm
        ? (await opts.warm.listTokensCreatedByUser(u.id)).map((t) => ({
            hash: t.tokenHash,
            label: t.label,
          }))
        : [];
      const global = await opts.metrics.snapshot();
      // Hand-attach token series — `snapshot()` is the global view and
      // doesn't take a token filter, so compute it via snapshotForTenant
      // on each tenant the admin's tokens belong to. In practice an admin
      // creates tokens against PUBLIC_TENANT only, so this is one call.
      const tokensByTenant = new Map<string, Array<{ hash: string; label: string | null }>>();
      if (opts.warm) {
        for (const row of await opts.warm.listTokensCreatedByUser(u.id)) {
          const arr = tokensByTenant.get(row.tenantId) ?? [];
          arr.push({ hash: row.tokenHash, label: row.label });
          tokensByTenant.set(row.tenantId, arr);
        }
      }
      const tokenRows = [];
      for (const [tenantId, list] of tokensByTenant) {
        const t = await opts.metrics.snapshotForTenant(tenantId, { tokens: list });
        if (t.tokens) tokenRows.push(...t.tokens);
      }
      return reply.send({ ...global, tokens: tokenRows, _hasMyTokens: myTokens.length > 0 });
    }
    if (!u.tenantId) return reply.code(400).send({ error: "user has no tenant assigned" });
    const myTokens = opts.warm
      ? (await opts.warm.listTokensCreatedByUser(u.id))
          .filter((t) => t.tenantId === u.tenantId)
          .map((t) => ({ hash: t.tokenHash, label: t.label }))
      : [];
    reply.send(await opts.metrics.snapshotForTenant(u.tenantId, { tokens: myTokens }));
  });

  app.get("/v1/me/tokens", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = req.dashUser!;
    if (!u.tenantId) return reply.code(400).send({ error: "user has no tenant assigned" });
    reply.send({ tokens: await opts.warm.listTenantTokens(u.tenantId) });
  });

  app.post("/v1/me/tokens", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = req.dashUser!;
    if (!u.tenantId) return reply.code(400).send({ error: "user has no tenant assigned" });
    const body = MintMyTokenBody.parse(req.body ?? {});
    // If a project is specified, the user must be a member.
    if (body.projectId) {
      const m = await opts.warm.getProjectMembership(body.projectId, u.id);
      if (!m) return reply.code(403).send({ error: "you are not a member of this project" });
    }
    const result = await opts.warm.createTenantToken(
      u.tenantId,
      body.label,
      u.id,
      body.projectId ?? null,
    );
    if (!result) return reply.code(404).send({ error: "tenant missing" });
    reply.code(201).send({
      ...result,
      warning: "Store this token now — it will not be shown again. Server retains only a sha256 hash.",
    });
  });

  app.post("/v1/me/tokens/:hash/revoke", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = req.dashUser!;
    if (!u.tenantId) return reply.code(400).send({ error: "user has no tenant assigned" });
    const hash = (req.params as { hash: string }).hash;
    if (!/^[a-f0-9]{64}$/i.test(hash)) return reply.code(400).send({ error: "invalid hash" });
    const ok = await opts.warm.revokeTenantTokenByHash(u.tenantId, hash);
    if (!ok) return reply.code(404).send({ error: "token not found or already revoked" });
    opts.metrics?.forgetToken(hash);
    reply.send({ revoked: true });
  });

  // ─── User self-service: projects (sub-brains) ──────────────────────────

  app.get("/v1/me/projects", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    reply.send({ projects: await opts.warm.listProjectsForUser(u.id) });
  });

  app.post("/v1/me/projects", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    if (!u.tenantId && u.role !== "admin") {
      return reply.code(400).send({ error: "user has no tenant assigned" });
    }
    const ownerTenantId = u.tenantId ?? PUBLIC_TENANT;
    const body = CreateProjectBody.parse(req.body);
    const existing = await opts.warm.getProject(body.id);
    if (existing) return reply.code(409).send({ error: "project id already exists" });
    const project = await opts.warm.createProject({
      id: body.id,
      name: body.name,
      ownerUserId: u.id,
      ownerTenantId,
    });
    await audit(req, "project.create", body.id, { name: body.name, ownerTenantId });
    reply.code(201).send(project);
  });

  app.delete("/v1/me/projects/:id", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    const id = (req.params as { id: string }).id;
    const project = await opts.warm.getProject(id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (project.ownerUserId !== u.id) {
      return reply.code(403).send({ error: "only the owner can delete a project" });
    }
    const r = await opts.engine.deleteProject(id);
    await audit(req, "project.delete", id, { entriesRemoved: r.entriesRemoved });
    reply.send(r);
  });

  app.get("/v1/me/projects/:id/members", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    const id = (req.params as { id: string }).id;
    const m = await opts.warm.getProjectMembership(id, u.id);
    if (!m) return reply.code(403).send({ error: "not a member of this project" });
    reply.send({ members: await opts.warm.listProjectMembers(id) });
  });

  app.post("/v1/me/projects/:id/members", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    const id = (req.params as { id: string }).id;
    const project = await opts.warm.getProject(id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (project.ownerUserId !== u.id) {
      return reply.code(403).send({ error: "only the owner can add members" });
    }
    const body = AddMemberBody.parse(req.body);
    const target = await opts.warm.findUserByUsername(body.username);
    if (!target) return reply.code(404).send({ error: "unknown user" });
    const ok = await opts.warm.addProjectMember(id, target.id, body.role ?? "member");
    if (!ok) return reply.code(409).send({ error: "user is already a member" });
    await audit(req, "project.member.add", id, {
      memberUserId: target.id,
      memberUsername: target.username,
      role: body.role ?? "member",
    });
    reply.code(201).send({ added: true, userId: target.id, username: target.username });
  });

  app.delete("/v1/me/projects/:id/members/:userId", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    const { id, userId } = req.params as { id: string; userId: string };
    const project = await opts.warm.getProject(id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    // Owner can remove anyone (except themselves — they should delete the
    // project instead). Members can only remove themselves (leave).
    const isOwner = project.ownerUserId === u.id;
    if (!isOwner && userId !== u.id) {
      return reply.code(403).send({ error: "only the owner can remove other members" });
    }
    if (userId === project.ownerUserId) {
      return reply.code(400).send({ error: "owner cannot leave; delete the project instead" });
    }
    const r = await opts.warm.removeProjectMember(id, userId);
    if (!r.removed) return reply.code(404).send({ error: "user is not a member" });
    await audit(req, "project.member.remove", id, {
      memberUserId: userId,
      tokensRevoked: r.tokensRevoked,
    });
    reply.send({ removed: true, tokensRevoked: r.tokensRevoked });
  });

  // ─── User self-service: data-plane proxies ──────────────────────────
  // The dashboard SPA is authenticated by cookie session, not a tenant
  // bearer, so it can't hit /v1/search etc. directly. These /v1/me/*
  // mirrors invoke the engine on behalf of the calling user, scoping
  // automatically to their tenant. Admin variants (no tenant) get
  // PUBLIC_TENANT, mirroring the bearer-mode behaviour.
  //
  // ── Project access guard ─────────────────────────────────────────────
  // Bearer-token routes enforce project scope by minting tokens only for
  // members. Cookie-authed mirrors don't go through token mint, so they
  // must check membership themselves — otherwise any user in tenant
  // `acme` could read/modify another user's project entries by passing
  // the project id in the body. Returns true if access ok; sends a 403
  // and returns false otherwise. `null` projectId means tenant-wide and
  // is always allowed (the existing tenant boundary still applies).
  async function requireProjectAccess(
    user: DashboardUser,
    projectId: string | null,
    reply: FastifyReply,
  ): Promise<boolean> {
    if (!projectId) return true;
    if (!opts.warm) {
      reply.code(404).send({ error: "warm store disabled" });
      return false;
    }
    const m = await opts.warm.getProjectMembership(projectId, user.id);
    if (!m) {
      reply.code(403).send({ error: "not a member of this project" });
      return false;
    }
    return true;
  }

  app.post("/v1/me/search", async (req, reply) => {
    const u = req.dashUser!;
    const body = SearchBody.parse(req.body);
    const project = body.project ?? null;
    if (!(await requireProjectAccess(u, project, reply))) return;
    const tenantId = u.tenantId ?? PUBLIC_TENANT;
    const r = await opts.engine.search(tenantId, { ...body, project });
    reply.send(r);
  });

  app.post("/v1/me/recent", async (req, reply) => {
    const u = req.dashUser!;
    const body = RecentBody.parse(req.body ?? {});
    const project = body.project ?? null;
    if (!(await requireProjectAccess(u, project, reply))) return;
    const tenantId = u.tenantId ?? PUBLIC_TENANT;
    reply.send(await opts.engine.recent(tenantId, { ...body, project }));
  });

  app.post("/v1/me/neighbors", async (req, reply) => {
    const u = req.dashUser!;
    const body = NeighborsBody.parse(req.body);
    const project = body.project ?? null;
    if (!(await requireProjectAccess(u, project, reply))) return;
    const tenantId = u.tenantId ?? PUBLIC_TENANT;
    try {
      reply.send(await opts.engine.neighbors(tenantId, { ...body, project }));
    } catch (err) {
      // Graph store occasionally returns Edge values the redis-client
      // decoder rejects ("Type mismatch: expected List or Null but was
      // Edge") — degrade to "no neighbours, graph degraded" so the SPA
      // still renders the seed inspector instead of a 500 modal.
      app.log?.warn?.({ err: (err as Error).message }, "[/v1/me/neighbors] degraded");
      reply.send({ seed: body.id, results: [], degraded: true });
    }
  });

  app.post("/v1/me/remember", async (req, reply) => {
    const u = req.dashUser!;
    const body = RememberBody.parse(req.body);
    const project = body.project ?? null;
    if (!(await requireProjectAccess(u, project, reply))) return;
    const tenantId = u.tenantId ?? PUBLIC_TENANT;
    const r = await opts.engine.remember(tenantId, { ...body, project });
    reply.code(201).send(r);
  });

  app.post("/v1/me/forget", async (req, reply) => {
    const u = req.dashUser!;
    const body = ForgetBody.parse(req.body);
    const project = body.project ?? null;
    if (!(await requireProjectAccess(u, project, reply))) return;
    const tenantId = u.tenantId ?? PUBLIC_TENANT;
    // Defence in depth: even after the requested-project check, resolve
    // the entry's actual scope by id alone and re-verify membership.
    // This stops an attacker who knows an entry id from deleting it by
    // passing `project: null` when the entry is actually project-scoped,
    // or by passing a project they're a member of when the entry belongs
    // to a different (non-member) project. Tenant-wide entries
    // (project_id null) need only the tenant boundary, which the engine
    // enforces. We use `getEntryScope` (no scope filter) instead of
    // `getEntry` because the latter filters by the caller-supplied
    // project, which is exactly the value we don't trust.
    if (opts.warm) {
      const scope = await opts.warm.getEntryScope(body.id);
      if (scope) {
        if (scope.projectId) {
          const m = await opts.warm.getProjectMembership(scope.projectId, u.id);
          if (!m) return reply.code(403).send({ error: "not a member of this project" });
        } else if (scope.tenantId !== tenantId) {
          // Tenant-wide entry in a different tenant — refuse.
          return reply.code(403).send({ error: "entry not in your tenant" });
        }
      }
    }
    reply.send(await opts.engine.forget(tenantId, body.id, { project }));
  });

  /** "Today" — lightweight activity feed for the user dashboard. We
   *  derive it from the recent memory_entries (kind = "remember") and
   *  recent tenant_tokens (kind = "token"). Cheap query, ranks by
   *  timestamp, capped at 50 events. */
  app.get("/v1/me/today", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "warm store disabled" });
    const u = req.dashUser!;
    const tenantId = u.tenantId ?? PUBLIC_TENANT;
    const events = await opts.warm.listRecentActivity(tenantId, u.id, 50);
    reply.send({ events });
  });

  /** Onboarding state — derived, not stored. Tells the SPA which steps
   *  in the welcome wizard are done so it can highlight the next one. */
  app.get("/v1/me/onboarding", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "warm store disabled" });
    const u = req.dashUser!;
    const tenantId = u.tenantId ?? PUBLIC_TENANT;
    const tokens = await opts.warm.listTokensCreatedByUser(u.id);
    const recent = u.tenantId
      ? await opts.engine.recent(u.tenantId, { k: 1 })
      : { results: [] as unknown[] };
    reply.send({
      bootstrapDone: true,
      tenantDone: u.role === "admin" || !!u.tenantId,
      mintedToken: tokens.length > 0,
      remembered: recent.results.length > 0,
      tenantId,
    });
  });

  app.post("/v1/admin/tenants", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const body = AdminCreateTenantBody.parse(req.body);
    const t = await opts.warm.createTenant(body.id, body.name);
    await audit(req, "tenant.create", body.id, { name: body.name });
    reply.code(201).send(t);
  });

  app.get("/v1/admin/tenants", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    reply.send({ tenants: await opts.warm.listTenants() });
  });

  app.post("/v1/admin/tenants/:id/tokens", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenantId = (req.params as { id: string }).id;
    const body = AdminCreateTokenBody.parse(req.body ?? {});
    const result = await opts.warm.createTenantToken(tenantId, body.label);
    if (!result) return reply.code(404).send({ error: "unknown tenant" });
    // Plaintext token is shown ONCE — server only stores the hash. Tell
    // the caller this clearly so they don't lose it.
    reply.code(201).send({
      ...result,
      warning: "Store this token now — it will not be shown again. Server retains only a sha256 hash.",
    });
  });

  app.get("/v1/admin/tenants/:id/tokens", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenantId = (req.params as { id: string }).id;
    reply.send({ tokens: await opts.warm.listTenantTokens(tenantId) });
  });

  app.post("/v1/admin/tokens/revoke", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const body = AdminRevokeBody.parse(req.body);
    const ok = await opts.warm.revokeTenantToken(body.token);
    reply.send({ revoked: ok });
  });

  // Tenant-scoped token revoke by hash — the path the admin dashboard uses.
  // The hash is non-secret (it's a sha256), and tenant-scoping the route
  // catches typos before they become cross-tenant accidents.
  app.post("/v1/admin/tenants/:tenantId/tokens/:hash/revoke", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const { tenantId, hash } = req.params as { tenantId: string; hash: string };
    if (!/^[a-f0-9]{64}$/i.test(hash)) return reply.code(400).send({ error: "invalid hash" });
    const ok = await opts.warm.revokeTenantTokenByHash(tenantId, hash);
    if (!ok) return reply.code(404).send({ error: "token not found or already revoked" });
    await audit(req, "token.revoke", `${tenantId}:${hash.slice(0, 8)}`, {});
    reply.send({ revoked: true });
  });

  // Audit log read (admin only).
  app.get("/v1/admin/audit-log", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 200), 500);
    reply.send({ entries: await opts.warm.listAuditLog({ limit }) });
  });

  // Delete a tenant: warm rows + cold collections + graph nodes + tokens.
  // Hard delete; the warning is in the dashboard and README. The synthetic
  // `public` tenant is refused by the warm-store layer.
  app.delete("/v1/admin/tenants/:id", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const id = (req.params as { id: string }).id;
    if (id === "public") return reply.code(400).send({ error: "cannot delete the public tenant" });
    const r = await opts.engine.deleteTenant(id);
    if (!r.deleted) return reply.code(404).send({ error: "unknown tenant" });
    await audit(req, "tenant.delete", id, { entriesRemoved: r.entriesRemoved });
    reply.send(r);
  });

  // ─── Tenant token self-rotation (CLI / device path) ────────────────────
  // Holders of a tenant bearer (devices, CLIs) can rotate their own token
  // without needing admin access: present the current bearer, get a new
  // plaintext back (shown once), old one revoked atomically. Only meaningful
  // in tenant mode. Note: distinct from the dashboard's /v1/me/tokens —
  // this endpoint is for the *bearer* itself to roll over, the dashboard
  // is for user-facing CRUD.
  app.post("/v1/auth/rotate-token", async (req, reply) => {
    if (opts.auth.mode !== "tenant" || !opts.warm) {
      return reply.code(400).send({ error: "rotate-token is only available in tenant mode" });
    }
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const current = header.slice("Bearer ".length);
    const result = await opts.warm.rotateTenantToken(current);
    if (!result) return reply.code(401).send({ error: "unauthorized" });
    reply.code(201).send({
      ...result,
      warning: "Store this token now — it will not be shown again. The previous token is revoked.",
    });
  });

  // ─── Admin: operational metrics ───────────────────────────────────────
  // Read-through snapshot of in-process counters/gauges/rates. Gated by
  // session-admin auth AND the dashboard flag — operators who don't want
  // the surface set NOVAMEM_ADMIN_DASHBOARD=0 and the route disappears.
  const dashboardEnabled = opts.adminDashboard !== false;
  app.get("/v1/admin/metrics", async (req, reply) => {
    if (!dashboardEnabled || !opts.metrics) {
      return reply.code(404).send({ error: "admin disabled" });
    }
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    reply.send(await opts.metrics.snapshot());
  });

  // P2-18: Prometheus exposition format for scraping. Uses the same
  // gauges + counters as the JSON endpoint; admin-token gated so a
  // public scraper can't enumerate tenants/projects via the dashboard.
  app.get("/v1/admin/metrics/prom", async (req, reply) => {
    if (!dashboardEnabled || !opts.metrics) {
      return reply.code(404).send({ error: "admin disabled" });
    }
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(await opts.metrics.renderProm());
  });

  // /openapi.json is now served by @fastify/swagger.

  // ─── MCP via SSE ──────────────────────────────────────────────────
  // The same engine is exposed through buildMcpServer() — over stdio for
  // local hosts (packages/server/src/main.ts can launch that), and over
  // HTTP+SSE here for remote hosts.
  //
  // GET  /mcp/sse                    — opens the event stream, returns sessionId
  // POST /mcp/messages?sessionId=…   — sends JSON-RPC requests on that session
  //
  // Per-session transports live in this map for the lifetime of the
  // SSE connection. They're disposed when the client disconnects.

  // SSE-MCP: tenant is captured at the GET /mcp/sse handshake (when the
  // bearer auth hook ran and populated req.tenantId) and persisted with
  // the transport for the session's lifetime. Subsequent POST /mcp/messages
  // calls inherit that tenant — they're authenticated by sessionId, not
  // by a new bearer header on every JSON-RPC call.
  const sseTransports = new Map<string, {
    transport: SSEServerTransport;
    tenantId: string;
    mcpServer: ReturnType<typeof buildMcpServer>;
  }>();

  // P2-17: drain in-flight SSE connections on shutdown so Fastify's `close()`
  // doesn't hang waiting for keep-alive responses to complete.
  app.addHook("onClose", async () => {
    for (const [sessionId, s] of [...sseTransports.entries()]) {
      try {
        await s.mcpServer.close();
      } catch {
        // ignore — best-effort drain
      }
      sseTransports.delete(sessionId);
    }
  });

  app.get("/mcp/sse", async (req, reply) => {
    const transport = new SSEServerTransport("/mcp/messages", reply.raw);
    const sessionId = transport.sessionId;
    const tenantId = req.tenantId;
    const mcpServer = buildMcpServer(
      opts.engine,
      {
        tenantId,
        projectId: req.bearerProjectId ?? null,
        userId: req.dashUser?.id ?? null,
      },
      opts.warm,
    );
    sseTransports.set(sessionId, { transport, tenantId, mcpServer });
    await mcpServer.connect(transport);
    req.log.info({ sessionId, tenantId }, "mcp-sse: session opened");
    const cleanup = () => {
      sseTransports.delete(sessionId);
      mcpServer.close().catch(() => undefined);
      req.log.info({ sessionId }, "mcp-sse: session closed");
    };
    // Listen on both `close` and `error` — the previous version only
    // cleaned up on `close`, so an `error` event leaked the entry.
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
  });

  app.post("/mcp/messages", async (req, reply) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId;
    if (!sessionId) return reply.code(400).send({ error: "missing sessionId" });
    const session = sseTransports.get(sessionId);
    if (!session) return reply.code(404).send({ error: "unknown sessionId" });
    await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
  });

  return app;
}
