/**
 * Fastify HTTP transport. Mirrors the engine API one-to-one with light
 * validation via Zod on the request bodies, plus an MCP/SSE bridge for
 * remote MCP-aware hosts.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

import type { MemoryEngine } from "./engine/index.js";
import type { MetricsCollector } from "./admin/metrics.js";
import { hashPassword, verifyPassword, SESSION_TTL_MS } from "./auth.js";
import { buildMcpServer } from "./mcp.js";
import { openapiSpec } from "./openapi.js";
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
    /** Resolved dashboard user — populated by the dashboard auth hook for
     *  /v1/auth/* /v1/me/* /v1/admin/* /v1/decay routes when a session
     *  bearer is present. Undefined for data-plane requests authed by a
     *  tenant token. */
    dashUser?: DashboardUser;
  }
}

/** Hard cap on stored content size — prevents a single oversized POST from
 *  exhausting memory or the DB row size limit. ~256KB is plenty for any
 *  reasonable memory entry. */
const MAX_CONTENT_BYTES = 256 * 1024;

const ProjectIdRule = z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i);

const SearchBody = z.object({
  query: z.string().min(1).max(8 * 1024),
  k: z.number().int().positive().max(100).optional(),
  namespace: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  /** Sub-brain scope. Omitted = tenant-wide entries. */
  project: ProjectIdRule.optional().nullable(),
  weights: z
    .object({
      keyword: z.number().optional(),
      vector: z.number().optional(),
      graph: z.number().optional(),
    })
    .optional(),
});

const RememberBody = z.object({
  content: z.string().min(1).max(MAX_CONTENT_BYTES),
  namespace: z.string().max(128).optional(),
  source: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  project: ProjectIdRule.optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
});

const DecayBody = z.object({
  effectiveDays: z.number().positive().optional(),
});

const RecentBody = z.object({
  namespace: z.string().max(128).optional(),
  k: z.number().int().positive().max(200).optional(),
  /** ISO-8601 lower bound. */
  since: z.string().optional(),
  project: ProjectIdRule.optional().nullable(),
});

const NeighborsBody = z.object({
  id: z.string().min(1).max(128),
  depth: z.number().int().positive().max(3).optional(),
  k: z.number().int().positive().max(50).optional(),
  project: ProjectIdRule.optional().nullable(),
});

const ForgetBody = z.object({
  id: z.string().min(1).max(128),
  project: ProjectIdRule.optional().nullable(),
});

// Admin bodies — kept short, slug-safe ids.
const AdminCreateTenantBody = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "tenant id must be lowercase alphanumeric / underscore / hyphen",
  }),
  name: z.string().min(1).max(128),
});

const AdminCreateTokenBody = z.object({
  label: z.string().max(128).optional(),
});

const AdminRevokeBody = z.object({
  token: z.string().min(1).max(256),
});

// ─── Dashboard auth & user-management bodies ────────────────────────────

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const UsernameRule = z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i, {
  message: "username must be 2–64 chars; alphanumeric, dot, underscore, dash",
});

const CreateUserBody = z
  .object({
    username: UsernameRule,
    password: z.string().min(8).max(256),
    role: z.enum(["admin", "user"]),
    tenantId: z.string().min(1).max(64).optional().nullable(),
  })
  .refine((v) => v.role === "admin" || (typeof v.tenantId === "string" && v.tenantId.length > 0), {
    message: "role 'user' requires a tenantId",
    path: ["tenantId"],
  });

const SetRoleBody = z
  .object({
    role: z.enum(["admin", "user"]),
    tenantId: z.string().min(1).max(64).optional().nullable(),
  })
  .refine((v) => v.role === "admin" || (typeof v.tenantId === "string" && v.tenantId.length > 0), {
    message: "role 'user' requires a tenantId",
    path: ["tenantId"],
  });

const MintMyTokenBody = z.object({
  label: z.string().max(128).optional(),
  /** Optional project scope. Null/omitted = tenant-wide token (legacy). */
  projectId: ProjectIdRule.optional().nullable(),
});

const CreateProjectBody = z.object({
  id: ProjectIdRule,
  name: z.string().min(1).max(128),
});

const AddMemberBody = z.object({
  username: z.string().min(1).max(64),
  role: z.enum(["owner", "member"]).optional(),
});

export interface HttpOptions {
  engine: MemoryEngine;
  /** Warm store — only used by the auth hook to resolve tenant tokens.
   *  Required when auth.mode = 'tenant'; optional otherwise. */
  warm?: WarmStore;
  auth: { mode: "none" | "bearer" | "tenant"; token?: string; adminToken?: string };
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
    if (!opts.auth.adminToken) {
      throw new Error("auth.mode = 'tenant' requires auth.adminToken (NOVAMEM_ADMIN_TOKEN)");
    }
    if (!opts.warm) {
      throw new Error("auth.mode = 'tenant' requires the warm store to resolve tenant tokens");
    }
  }

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 2 * 1024 * 1024 });
  app.register(cors, { origin: true });

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
  //   anything else → could be the legacy NOVAMEM_ADMIN_TOKEN (used by CI
  //   scripts directly against /v1/admin/*) or `bearer` mode shared token.
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
    // plane handlers consult `req.dashUser` and admin endpoints accept
    // either a session-admin OR the legacy admin token.
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (token.startsWith("ns_") && opts.warm) {
      const session = await opts.warm.resolveSession(token);
      if (session) req.dashUser = session.user;
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

    // /v1/admin/* — handlers do their own check (legacy admin token OR
    // session-admin). Tenant id is irrelevant for admin routes.
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
  });

  // ─── Admin dashboard (static SPA) ────────────────────────────────────
  // Hand-rolled Preact + htm bundle under src/admin/ui. Mounted under
  // /admin/* with a strict CSP so even a stray inline-script attempt would
  // fail closed. The SPA fetches /v1/admin/* via the admin token stored
  // in sessionStorage. When the dashboard is disabled, we register no
  // routes — the server will 404 /admin and /admin/* automatically.
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

  /** Resolve the project a request should be scoped to. Rules:
   *   - Project-scoped bearer: forced to that project. A different `project`
   *     in body → 403.
   *   - Tenant-wide bearer (no project on token): tenant-wide entries only.
   *     A `project` in body → 403 ("mint a project-scoped token").
   *  Returns the project id (or null) on success, or undefined after
   *  sending a 403 reply. */
  function resolveRequestProject(
    req: { bearerProjectId?: string | null },
    bodyProject: string | null | undefined,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
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
        error: "this bearer is tenant-wide; mint a project-scoped token to access a project",
      });
      return undefined;
    }
    return null;
  }

  app.post("/v1/search", async (req, reply) => {
    const body = SearchBody.parse(req.body);
    const project = resolveRequestProject(req, body.project ?? null, reply);
    if (project === undefined) return reply;
    const r = await opts.engine.search(req.tenantId, { ...body, project });
    reply.send(r);
  });

  app.post("/v1/remember", async (req, reply) => {
    const body = RememberBody.parse(req.body);
    const project = resolveRequestProject(req, body.project ?? null, reply);
    if (project === undefined) return reply;
    const r = await opts.engine.remember(req.tenantId, { ...body, project });
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
    reply.send(await opts.engine.forget(req.tenantId, body.id, { project }));
  });

  app.get("/v1/stats", async (req, reply) => {
    reply.send(await opts.engine.stats(req.tenantId));
  });

  // ─── Admin: tenant + token bootstrap ──────────────────────────────────
  // Gated by NOVAMEM_ADMIN_TOKEN. Available in any auth mode (so you can
  // seed tenants before flipping the service into 'tenant' mode), but if
  // mode != 'tenant' the warm store and admin token may not be configured —
  // we hard-require them at handler-time and 404 otherwise.

  /** Admin gate for /v1/admin/*. Accepts EITHER a logged-in admin user
   *  (preferred — what the dashboard uses) OR the legacy NOVAMEM_ADMIN_TOKEN
   *  (kept for CI scripts and manual curl). */
  const adminAuth = (req: { headers: { authorization?: string }; dashUser?: DashboardUser }): boolean => {
    if (req.dashUser?.role === "admin") return true;
    if (!opts.auth.adminToken) return false;
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) return false;
    return safeEqual(h.slice("Bearer ".length), opts.auth.adminToken);
  };

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
    const user = await opts.warm.findUserByUsername(body.username);
    // Constant-ish-time: always run a verifyPassword against something to
    // avoid leaking whether the username exists. We compare against a
    // throwaway hash when the user is missing.
    const ok = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyPassword(body.password, "$2a$10$invalidsaltinvalidsaltinvalidsaltinvalid");
    if (!user || !ok) {
      return reply.code(401).send({ error: "invalid username or password" });
    }
    const session = await opts.warm.createSession(user.id, SESSION_TTL_MS);
    reply.code(201).send({
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
      },
    });
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const h = req.headers.authorization;
    if (opts.warm && h && h.startsWith("Bearer ")) {
      await opts.warm.revokeSession(h.slice("Bearer ".length));
    }
    reply.code(204).send();
  });

  app.get("/v1/auth/me", async (req, reply) => {
    // Auth hook already resolved the session; if we got here it's valid.
    reply.send({ user: req.dashUser });
  });

  // ─── Admin: user management ────────────────────────────────────────────
  // Distinct from legacy /v1/admin/tenants/* — these are dashboard logins.
  // Only an admin (session or legacy admin token) can manage them.

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
    reply.send({ updated: ok });
  });

  // ─── User self-service: scoped metrics + own-tenant tokens ─────────────

  app.get("/v1/me/metrics", async (req, reply) => {
    const u = req.dashUser!;
    if (!opts.metrics) return reply.code(404).send({ error: "metrics disabled" });
    if (u.role === "admin") {
      // Admins use /v1/admin/metrics; this endpoint exists for the user
      // dashboard. Redirect-by-content: return the global snapshot.
      return reply.send(await opts.metrics.snapshot());
    }
    if (!u.tenantId) return reply.code(400).send({ error: "user has no tenant assigned" });
    reply.send(await opts.metrics.snapshotForTenant(u.tenantId));
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
    const ok = await opts.warm.removeProjectMember(id, userId);
    if (!ok) return reply.code(404).send({ error: "user is not a member" });
    reply.send({ removed: true });
  });

  app.post("/v1/admin/tenants", async (req, reply) => {
    if (!opts.warm) return reply.code(404).send({ error: "admin disabled" });
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    const body = AdminCreateTenantBody.parse(req.body);
    const t = await opts.warm.createTenant(body.id, body.name);
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
    reply.send({ revoked: true });
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
  // the admin token AND the dashboard flag — operators who don't want the
  // surface set NOVAMEM_ADMIN_DASHBOARD=0 and the route disappears entirely.
  const dashboardEnabled = opts.adminDashboard !== false;
  app.get("/v1/admin/metrics", async (req, reply) => {
    if (!dashboardEnabled || !opts.metrics) {
      return reply.code(404).send({ error: "admin disabled" });
    }
    if (!adminAuth(req)) return reply.code(401).send({ error: "unauthorized" });
    reply.send(await opts.metrics.snapshot());
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
  const sseTransports = new Map<string, { transport: SSEServerTransport; tenantId: string }>();

  app.get("/mcp/sse", async (req, reply) => {
    const transport = new SSEServerTransport("/mcp/messages", reply.raw);
    const sessionId = transport.sessionId;
    const tenantId = req.tenantId;
    sseTransports.set(sessionId, { transport, tenantId });
    const mcpServer = buildMcpServer(
      opts.engine,
      {
        tenantId,
        projectId: req.bearerProjectId ?? null,
        userId: req.dashUser?.id ?? null,
      },
      opts.warm,
    );
    await mcpServer.connect(transport);
    req.log.info({ sessionId, tenantId }, "mcp-sse: session opened");
    reply.raw.on("close", () => {
      sseTransports.delete(sessionId);
      mcpServer.close().catch(() => undefined);
      req.log.info({ sessionId }, "mcp-sse: session closed");
    });
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
