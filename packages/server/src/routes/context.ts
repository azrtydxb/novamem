/**
 * Shared types + helpers used across the route modules. The HTTP layer
 * was a 974-LOC mega-function; split into per-group modules that each
 * receive this context plus the Fastify app instance.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { MemoryEngine } from "../engine/index.js";
import type { MetricsCollector } from "../admin/metrics.js";
import type { WarmStore } from "../warm-store/index.js";

export interface DashboardUser {
  id: string;
  username: string;
  role: string;
}

export interface RouteContext {
  engine: MemoryEngine;
  warm?: WarmStore;
  metrics?: MetricsCollector;
  auth: { mode: "none" | "bearer" | "user"; token?: string };
  /** Master switch for /admin/* + /v1/admin/metrics. */
  adminDashboard: boolean;
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

export type RouteRegistrar = (app: FastifyInstance, ctx: RouteContext) => void;
