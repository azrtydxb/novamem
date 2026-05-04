/**
 * Fastify HTTP transport. Mirrors the engine API one-to-one with light
 * validation via Zod on the request bodies, plus an MCP/SSE bridge for
 * remote MCP-aware hosts.
 */

import { randomUUID } from "node:crypto";
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
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

import type { MemoryEngine } from "./engine/index.js";
import type { MetricsCollector } from "./admin/metrics.js";
import { buildMcpServer } from "./mcp.js";
import { openapiSpec } from "./openapi.js";
import {
  AddMemberBody,
  AdminRevokeBody,
  ChangePasswordBody,
  ActiveProjectBody,
  CreateProjectBody,
  UpdateMemoryBody,
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
import { SYSTEM_USER, type WarmStore } from "./warm-store/index.js";

export interface DashboardUser {
  id: string;
  username: string;
  role: string;
}

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

// Zod request-body schemas live in `routes/schemas.ts` so they can be
// imported by tests, the OpenAPI generator, and the MCP shim. See that
// file for the per-schema docstrings.

export interface HttpOptions {
  engine: MemoryEngine;
  /** Warm store — only used by the auth hook to resolve user bearers.
   *  Required when auth.mode = 'user'; optional otherwise. */
  warm?: WarmStore;
  auth: { mode: "none" | "bearer" | "user"; token?: string };
  /** Per-IP requests-per-minute. Default 600 (10/sec sustained). */
  rateLimitPerMinute?: number;
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
    getSession: (
      headers: Headers,
    ) => Promise<{ user?: { id: string }; session?: { id: string } } | null | undefined>;
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

  // Auth hook — resolves either a user bearer (data plane) or a session
  // bearer (control plane). Public routes skip. Dashboard control-plane
  // routes (/v1/auth, /v1/me, /v1/admin) do their own RBAC checks inside
  // their handlers using `req.dashUser`.
  //
  // Bearer prefixes:
  //   nm_<...>   user bearer (data plane)
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
      req.userId = SYSTEM_USER;
      return;
    }
    // Dashboard static assets are public — HTML shell must load before login.
    if (req.url === "/admin" || req.url.startsWith("/admin/")) {
      req.userId = SYSTEM_USER;
      return;
    }
    // Better Auth handler — owns its own auth. The passthrough route
    // (registered below) calls into Better Auth's handler() directly.
    // We must skip our auth hook so Better Auth gets the raw request.
    if (req.url.startsWith("/api/auth/")) {
      req.userId = SYSTEM_USER;
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
      req.userId = SYSTEM_USER;
      return;
    }

    // Resolve the caller's identity. Two routes produce a `dashUser`:
    //   1. Better Auth session — set by the SPA login flow; resolved by
    //      asking Better Auth's API for the session attached to the
    //      incoming request's headers (cookie OR Authorization Bearer
    //      with a Better Auth session token).
    //   2. Our own user-bearer (`nm_…`) — non-browser callers (MCP, CLI)
    //      send these. Resolved against `user_tokens`; the bearer's
    //      owning user becomes the dashUser so /v1/me/* works uniformly.
    const header = req.headers.authorization;
    const headerToken =
      header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (opts.betterAuth?.getSession) {
      // Pass the raw incoming headers to Better Auth so it can read its
      // own session cookie + Authorization header. Better Auth returns
      // `{ user, session }` on hit, or null/undefined when no session is
      // resolvable from the request.
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
            req.dashUser = u;
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

    // Data-plane (search/remember/forget/etc.) — user bearer required
    // unless mode = none/bearer.
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

  // ─── Better Auth passthrough ────────────────────────────────────────
  // Better Auth speaks the WHATWG Request/Response interface; Fastify
  // gives us node req/res. We bridge by reconstructing a Request from
  // the incoming Fastify request, calling Better Auth's handler, and
  // copying the Response back. All HTTP methods on /api/auth/* go here.
  if (opts.betterAuth) {
    const ba = opts.betterAuth;
    /** Refuse operations that would leave the system with zero admins.
     *  Better Auth's admin plugin doesn't enforce this on its own —
     *  remove-user / set-role accept any target. We intercept the two
     *  paths that can drop the admin count and 400 when the target is
     *  the last surviving admin. */
    const guardLastAdmin = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<boolean> => {
      if (!opts.warm || req.method !== "POST") return true;
      const path = req.url.split("?")[0] ?? "";
      const isRemove = path === "/api/auth/admin/remove-user";
      const isSetRole = path === "/api/auth/admin/set-role";
      if (!isRemove && !isSetRole) return true;
      const body = (req.body ?? {}) as { userId?: string; role?: string };
      const targetId = body.userId;
      if (!targetId) return true;
      // Demotion: only block when the new role is non-admin.
      if (isSetRole && body.role === "admin") return true;
      const r = await opts.warm.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "user"
          WHERE role = 'admin' AND id <> $1`,
        [targetId],
      );
      const remainingAdmins = Number(r.rows[0]?.count ?? "0");
      if (remainingAdmins > 0) return true;
      const action = isRemove ? "delete" : "demote";
      reply.code(400).send({
        message: `cannot ${action} the last admin — promote another user first`,
        code: "LAST_ADMIN_PROTECTED",
      });
      return false;
    };

    const passthrough = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await guardLastAdmin(req, reply))) return;
      // Build a WHATWG Request. We need the absolute URL, not just the
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
      // Copy status + headers + body back into the Fastify reply.
      reply.code(wRes.status);
      wRes.headers.forEach((value, key) => {
        // Set-Cookie may appear multiple times; Headers.forEach merges,
        // but Fastify's reply.header also handles multi-valued cookies
        // when we pass an array. Better Auth typically emits a single
        // Set-Cookie per response so the simple path works.
        reply.header(key, value);
      });
      const text = await wRes.text();
      reply.send(text);
    };
    // Register all common HTTP methods so the SPA's POSTs and the
    // browser's GETs both flow through.
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"] as const) {
      app.route({ method, url: "/api/auth/*", handler: passthrough });
    }
  }

  // Browsers automatically request /favicon.ico from the page origin. Without
  // a handler it 404s after going through the auth hook (which we already
  // skip for this URL); explicit empty-204 keeps console clean.
  app.get("/favicon.ico", async (_req, reply) => reply.code(204).send());

  /** Project access guard for the data plane. A bearer's owning user
   *  has access to every project they're a member of. When `body.project`
   *  is set, we look up `project_members` once and 403 if the bearer's
   *  user isn't on the list. `null` = global namespace, always allowed.
   *
   *  `body.includeProjects` (the active-project mode) is also membership-
   *  checked — search returns global ∪ those projects, and we refuse any
   *  ids the user can't see. */
  /** Resolve a single project reference (id or human name) to its real
   *  ULID, or null when nothing matches. The caller supplies a value
   *  from the request body; we first try treating it as an id, then fall
   *  back to a name lookup scoped to the caller's visibility. */
  async function resolveProjectRef(
    userId: string,
    value: string,
  ): Promise<{ id: string; ownerUserId: string } | null> {
    if (!opts.warm) return null;
    const byId = await opts.warm.getProject(value);
    if (byId) return { id: byId.id, ownerUserId: byId.ownerUserId };
    const byName = await opts.warm.findProjectByName(userId, value);
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
  async function checkProjectAccess(
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
    if (!opts.warm) return true;
    // Default-from-active-project: only when caller didn't pass an
    // explicit scope. Explicit project=null / project: <id> wins.
    const noScope =
      !body.project && (!body.includeProjects || body.includeProjects.length === 0);
    if (noScope) {
      const active = await opts.warm.getActiveProject(userId);
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
      const resolved = await resolveProjectRef(userId, ref.value);
      if (!resolved) {
        reply.code(404).send({
          error: `no such project '${ref.value}' — call project.list to see ids`,
        });
        return false;
      }
      const m = await opts.warm.getProjectMembership(resolved.id, userId);
      if (!m) {
        reply.code(403).send({
          error: `not a member of project '${ref.value}' (id ${resolved.id})`,
        });
        return false;
      }
      // Rewrite the request body in place with the resolved ULID so the
      // engine sees only canonical ids and never has to redo this.
      if (ref.field === "project") body.project = resolved.id;
      else body.includeProjects![ref.index!] = resolved.id;
    }
    return true;
  }

  app.post("/v1/search", async (req, reply) => {
    const body = SearchBody.parse(req.body);
    if (!(await checkProjectAccess(req.userId, body, reply))) return;
    const r = await opts.engine.search(req.userId, body, req.bearerToken);
    reply.send(r);
  });

  app.post("/v1/remember", async (req, reply) => {
    const body = RememberBody.parse(req.body);
    if (!(await checkProjectAccess(req.userId, body, reply, false))) return;
    const r = await opts.engine.remember(req.userId, body, req.bearerToken);
    reply.code(201).send(r);
  });

  app.post("/v1/decay", async (req, reply) => {
    const body = DecayBody.parse(req.body ?? {});
    const r = await opts.engine.decay({ effectiveDaysOverride: body.effectiveDays });
    reply.send(r);
  });

  app.post("/v1/dream-cycle", async (_req, reply) => {
    // Manual trigger for the dedup-merge + edge-promotion pass. The same
    // logic runs daily via the timer in main.ts; this endpoint exists
    // for ad-hoc compaction (after a bulk import) and tests.
    const r = await opts.engine.dreamCycle();
    reply.send(r);
  });

  app.put("/v1/memories/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = UpdateMemoryBody.parse(req.body ?? {});
    if (!(await checkProjectAccess(req.userId, body, reply, false))) return;
    const r = await opts.engine.update(req.userId, id, body);
    if (!r.updated) return reply.code(404).send({ error: "no such memory in your scope" });
    reply.send({ id, ...r });
  });

  app.post("/v1/reap-orphans", async (_req, reply) => {
    // Manual trigger for the cold-orphan reaper. The same pass also runs
    // automatically inside the decay loop (main.ts). Cross-user by design —
    // each orphan row carries its own user_id.
    reply.send(await opts.engine.reapOrphans());
  });

  app.post("/v1/recent", async (req, reply) => {
    const body = RecentBody.parse(req.body ?? {});
    if (!(await checkProjectAccess(req.userId, body, reply))) return;
    reply.send(await opts.engine.recent(req.userId, body));
  });

  app.post("/v1/neighbors", async (req, reply) => {
    const body = NeighborsBody.parse(req.body);
    if (!(await checkProjectAccess(req.userId, body, reply))) return;
    reply.send(await opts.engine.neighbors(req.userId, body));
  });

  app.post("/v1/forget", async (req, reply) => {
    const body = ForgetBody.parse(req.body);
    if (!(await checkProjectAccess(req.userId, body, reply, false))) return;
    reply.send(
      await opts.engine.forget(req.userId, body.id, { project: body.project ?? null, token: req.bearerToken }),
    );
  });

  app.get("/v1/stats", async (req, reply) => {
    reply.send(await opts.engine.stats(req.userId));
  });

  // ─── Admin: user + token bootstrap ──────────────────────────────────
  // Available in any auth mode (so you can seed users before flipping
  // the service into 'user' mode), but if mode != 'user' the warm
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

  // ─── Dashboard auth ───────────────────────────────────────────────────
  // Login / logout / get-session / change-password are owned by Better
  // Auth, mounted at /api/auth/* via the passthrough route above. The
  // legacy /v1/auth/* endpoints are gone — clients call /api/auth/*.

  // ─── Admin: user management ────────────────────────────────────────────
  // Better Auth owns user CRUD. The dashboard SPA calls
  // /api/auth/admin/{create-user,list-users,set-role,remove-user}
  // directly through the Better Auth passthrough route. Those endpoints
  // are gated by Better Auth's admin plugin (caller must have role=admin).
  // Audit-log entries for user.* events are emitted by Better Auth's
  // own hooks; we no longer wrap them.

  // ─── User self-service: scoped metrics + own-user bearers ─────────────

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
      // doesn't take a token filter, so compute it via snapshotForUser
      // on each user the admin's tokens belong to. In practice an admin
      // creates tokens against SYSTEM_USER only, so this is one call.
      const tokensByUser = new Map<string, Array<{ hash: string; label: string | null }>>();
      if (opts.warm) {
        for (const row of await opts.warm.listTokensCreatedByUser(u.id)) {
          const arr = tokensByUser.get(row.userId) ?? [];
          arr.push({ hash: row.tokenHash, label: row.label });
          tokensByUser.set(row.userId, arr);
        }
      }
      const tokenRows = [];
      for (const [userId, list] of tokensByUser) {
        const t = await opts.metrics.snapshotForUser(userId, { tokens: list });
        if (t.tokens) tokenRows.push(...t.tokens);
      }
      return reply.send({ ...global, tokens: tokenRows, _hasMyTokens: myTokens.length > 0 });
    }
    if (!u.id) return reply.code(400).send({ error: "user has no id assigned" });
    const myTokens = opts.warm
      ? (await opts.warm.listTokensCreatedByUser(u.id))
          .filter((t) => t.userId === u.id)
          .map((t) => ({ hash: t.tokenHash, label: t.label }))
      : [];
    reply.send(await opts.metrics.snapshotForUser(u.id, { tokens: myTokens }));
  });

  app.get("/v1/me/metrics/history", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "warm store disabled" });
    const u = req.dashUser!;
    // Default window is 24h. Cap at 48h to bound the response size.
    const q = (req.query as { hours?: string } | undefined)?.hours;
    const hours = Math.min(48, Math.max(1, q ? Number(q) : 24));
    const since = Date.now() - hours * 60 * 60 * 1000;
    const samples = await opts.warm.getMetricsHistory(u.id, since);
    reply.send({
      hours,
      samples: samples.map((s) => ({
        sampledAt: s.sampledAt.toISOString(),
        queries: s.queries,
        remembers: s.remembers,
      })),
    });
  });

  app.get("/v1/me/tokens", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = req.dashUser!;
    if (!u.id) return reply.code(400).send({ error: "user has no id assigned" });
    reply.send({ tokens: await opts.warm.listUserTokens(u.id) });
  });

  app.post("/v1/me/tokens", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = req.dashUser!;
    if (!u.id) return reply.code(400).send({ error: "user has no id assigned" });
    const body = MintMyTokenBody.parse(req.body ?? {});
    // Tokens have no per-project scope — access flows from the owning
    // user's memberships at request time.
    const result = await opts.warm.createUserToken(u.id, body.label);
    if (!result) return reply.code(404).send({ error: "user missing" });
    reply.code(201).send({
      ...result,
      warning: "Store this token now — it will not be shown again. Server retains only a sha256 hash.",
    });
  });

  /** Hard-delete a token by its sha256 hash. Removes the row outright
   *  (no soft "revoked" tombstone) so the list view doesn't accumulate
   *  dead entries. The device using it gets 401 on its next call. */
  app.delete("/v1/me/tokens/:hash", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "tokens disabled" });
    const u = req.dashUser!;
    const hash = (req.params as { hash: string }).hash;
    if (!/^[a-f0-9]{64}$/i.test(hash)) return reply.code(400).send({ error: "invalid hash" });
    const ok = await opts.warm.deleteUserTokenByHash(u.id, hash);
    if (!ok) return reply.code(404).send({ error: "token not found" });
    opts.metrics?.forgetToken(hash);
    reply.send({ deleted: true });
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
    const body = CreateProjectBody.parse(req.body);
    const project = await opts.warm.createProject({
      name: body.name,
      ownerUserId: u.id,
    });
    await audit(req, "project.create", project.id, { name: body.name });
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
    await audit(req, "project.member.remove", id, { memberUserId: userId });
    reply.send({ removed: true });
  });

  // ─── Active project pointer ────────────────────────────────────────
  // Per-user "current sub-brain". When set, memory.* calls without an
  // explicit project arg default to the active project (read-side: union
  // with user-global; write-side: target the active project directly).
  // The dashboard sidebar reads/writes this; MCP tools project.activate
  // / project.deactivate are thin wrappers around the same flow.

  app.get("/v1/me/active-project", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    const projectId = await opts.warm.getActiveProject(u.id);
    if (!projectId) return reply.send({ active: null });
    const p = await opts.warm.getProject(projectId);
    if (!p) {
      // Stale pointer (project was deleted) — clean up + return null.
      await opts.warm.setActiveProject(u.id, null);
      return reply.send({ active: null });
    }
    reply.send({ active: { id: p.id, name: p.name } });
  });

  app.put("/v1/me/active-project", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    const body = ActiveProjectBody.parse(req.body);
    const resolved = await resolveProjectRef(u.id, body.project);
    if (!resolved) {
      return reply.code(404).send({ error: `no such project '${body.project}'` });
    }
    const m = await opts.warm.getProjectMembership(resolved.id, u.id);
    if (!m) return reply.code(403).send({ error: "not a member of this project" });
    await opts.warm.setActiveProject(u.id, resolved.id);
    reply.send({ active: { id: resolved.id } });
  });

  app.delete("/v1/me/active-project", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "projects disabled" });
    const u = req.dashUser!;
    await opts.warm.setActiveProject(u.id, null);
    reply.code(204).send();
  });

  // ─── User self-service: data-plane proxies ──────────────────────────
  // The dashboard SPA is authenticated by cookie session, not a user-bearer
  // bearer, so it can't hit /v1/search etc. directly. These /v1/me/*
  // mirrors invoke the engine on behalf of the calling user, scoping
  // automatically to their user namespace. Admin variants get
  // SYSTEM_USER, mirroring the bearer-mode behaviour.
  //
  // ── Project access guard ─────────────────────────────────────────────
  // Bearer-token routes enforce project scope by minting tokens only for
  // members. Cookie-authed mirrors don't go through token mint, so they
  // must check membership themselves — otherwise any user in
  // `acme` could read/modify another user's project entries by passing
  // the project id in the body. Returns true if access ok; sends a 403
  app.post("/v1/me/search", async (req, reply) => {
    const u = req.dashUser!;
    const body = SearchBody.parse(req.body);
    if (!(await checkProjectAccess(u.id, body, reply))) return;
    const r = await opts.engine.search(u.id, body);
    reply.send(r);
  });

  app.post("/v1/me/recent", async (req, reply) => {
    const u = req.dashUser!;
    const body = RecentBody.parse(req.body ?? {});
    if (!(await checkProjectAccess(u.id, body, reply))) return;
    reply.send(await opts.engine.recent(u.id, body));
  });

  app.post("/v1/me/neighbors", async (req, reply) => {
    const u = req.dashUser!;
    const body = NeighborsBody.parse(req.body);
    if (!(await checkProjectAccess(u.id, body, reply))) return;
    try {
      reply.send(await opts.engine.neighbors(u.id, body));
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
    if (!(await checkProjectAccess(u.id, body, reply, false))) return;
    const r = await opts.engine.remember(u.id, body);
    reply.code(201).send(r);
  });

  app.put("/v1/me/memories/:id", async (req, reply) => {
    const u = req.dashUser!;
    const id = (req.params as { id: string }).id;
    const body = UpdateMemoryBody.parse(req.body ?? {});
    if (!(await checkProjectAccess(u.id, body, reply, false))) return;
    const r = await opts.engine.update(u.id, id, body);
    if (!r.updated) return reply.code(404).send({ error: "no such memory in your scope" });
    reply.send({ id, ...r });
  });

  app.post("/v1/me/forget", async (req, reply) => {
    const u = req.dashUser!;
    const body = ForgetBody.parse(req.body);
    if (!(await checkProjectAccess(u.id, body, reply, false))) return;
    const userId = u.id;
    // Defence in depth: even after the requested-project check, resolve
    // the entry's actual scope by id alone and re-verify membership.
    // This stops an attacker who knows an entry id from deleting it by
    // passing `project: null` when the entry is actually project-scoped,
    // or by passing a project they're a member of when the entry belongs
    // to a different (non-member) project. User-wide entries
    // (project_id null) need only the user boundary, which the engine
    // enforces. We use `getEntryScope` (no scope filter) instead of
    // `getEntry` because the latter filters by the caller-supplied
    // project, which is exactly the value we don't trust.
    if (opts.warm) {
      const scope = await opts.warm.getEntryScope(body.id);
      if (scope) {
        if (scope.projectId) {
          const m = await opts.warm.getProjectMembership(scope.projectId, u.id);
          if (!m) return reply.code(403).send({ error: "not a member of this project" });
        } else if (scope.userId !== userId) {
          // User-wide entry owned by a different user — refuse.
          return reply.code(403).send({ error: "entry not in your user namespace" });
        }
      }
    }
    reply.send(await opts.engine.forget(userId, body.id, { project: body.project ?? null }));
  });

  /** "Today" — lightweight activity feed for the user dashboard. We
   *  derive it from the recent memory_entries (kind = "remember") and
   *  recent user_tokens (kind = "token"). Cheap query, ranks by
   *  timestamp, capped at 50 events. */
  app.get("/v1/me/today", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "warm store disabled" });
    const u = req.dashUser!;
    const events = await opts.warm.listRecentActivity(u.id, 50);
    reply.send({ events });
  });

  /** Onboarding state — derived, not stored. Tells the SPA which steps
   *  in the welcome wizard are done so it can highlight the next one. */
  app.get("/v1/me/onboarding", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "warm store disabled" });
    const u = req.dashUser!;
    const userId = u.id;
    const tokens = await opts.warm.listTokensCreatedByUser(u.id);
    const recent = u.id
      ? await opts.engine.recent(u.id, { k: 1 })
      : { results: [] as unknown[] };
    reply.send({
      bootstrapDone: true,
      userExists: u.role === "admin" || !!u.id,
      mintedToken: tokens.length > 0,
      remembered: recent.results.length > 0,
      userId,
    });
  });

  app.post("/v1/admin/tokens/revoke", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const body = AdminRevokeBody.parse(req.body);
    const ok = await opts.warm.revokeUserToken(body.token);
    reply.send({ revoked: ok });
  });

  // Audit log read (admin only).
  app.get("/v1/admin/audit-log", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 200), 500);
    reply.send({ entries: await opts.warm.listAuditLog({ limit }) });
  });

  // ─── User bearer self-rotation (CLI / device path) ────────────────────
  // Holders of a user bearer (devices, CLIs) can rotate their own token
  // without needing admin access: present the current bearer, get a new
  // plaintext back (shown once), old one revoked atomically. Only meaningful
  // in user mode. Note: distinct from the dashboard's /v1/me/tokens —
  // this endpoint is for the *bearer* itself to roll over, the dashboard
  // is for user-facing CRUD.
  app.post("/v1/auth/rotate-token", async (req, reply) => {
    if (opts.auth.mode !== "user" || !opts.warm) {
      return reply.code(400).send({ error: "rotate-token is only available in user mode" });
    }
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const current = header.slice("Bearer ".length);
    const result = await opts.warm.rotateUserToken(current);
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
  // public scraper can't enumerate users/projects via the dashboard.
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

  // SSE-MCP: user is captured at the GET /mcp/sse handshake (when the
  // bearer auth hook ran and populated req.userId) and persisted with
  // the transport for the session's lifetime. Subsequent POST /mcp/messages
  // calls inherit that user id — they're authenticated by sessionId, not
  // by a new bearer header on every JSON-RPC call.
  const sseTransports = new Map<string, {
    transport: SSEServerTransport;
    userId: string;
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
    const userId = req.userId;
    const mcpServer = buildMcpServer(opts.engine, { userId }, opts.warm);
    sseTransports.set(sessionId, { transport, userId, mcpServer });
    await mcpServer.connect(transport);
    req.log.info({ sessionId, userId }, "mcp-sse: session opened");
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
