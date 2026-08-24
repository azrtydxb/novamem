/** Thin wrapper around `fetch` for the dashboard SPA. Sessions live in
 *  an HttpOnly cookie set by Better Auth (`/api/auth/sign-in/email`).
 *  This module never reads the cookie directly — we `credentials:
 *  "include"` and the browser attaches it automatically. CSRF: Better
 *  Auth uses SameSite=Lax cookies + trusted-origin checks server-side,
 *  so the SPA doesn't need to echo a token back. */

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  body: T | null;
  error: string | null;
}

/**
 * Recoverable HTTP failure thrown by `api()` on non-2xx responses.
 *
 * Distinct from bare `Error` (which we reserve for unrecoverable
 * provider-not-mounted invariants in main.tsx / context files). A
 * consumer can `instanceof ApiError` to render `code`/`status` in a
 * toast vs. crashing the boundary.
 *
 * The `message` is the server's `error` field when present, otherwise
 * `HTTP <status>`. `code` is the optional machine-readable error code
 * the server may include alongside `error` (issue #23).
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export async function api<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  // Only declare content-type when there's a body — Fastify's JSON parser
  // 400s on `content-type: application/json` with empty payload.
  if (body !== undefined && body !== null)
    headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      // credentials: "include" tells the browser to attach the
      // novamem_session HttpOnly cookie on same-origin requests.
      credentials: "include",
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { status: 0, ok: false, body: null, error: (err as Error).message };
  }
  let parsed: T | null = null;
  let errMsg: string | null = null;
  let errCode: string | undefined;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      errMsg = text.slice(0, 200);
    }
  }
  if (!res.ok && parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if ("error" in obj) errMsg = String(obj.error);
    if ("code" in obj && typeof obj.code === "string") errCode = obj.code;
  }
  if (!res.ok) {
    // Throw ApiError so call sites no longer need to re-wrap with
    // `throw new Error(r.error ?? \`… ${r.status}\`)` (issue #23).
    throw new ApiError(errMsg ?? `HTTP ${res.status}`, res.status, errCode);
  }
  return { status: res.status, ok: res.ok, body: parsed, error: errMsg };
}

// ─── Typed shapes ──────────────────────────────────────────────────────

export interface HealthSnapshot {
  ok: boolean;
  deps: {
    warm: "ok" | "unreachable" | "disabled";
    cold: "ok" | "unreachable" | "disabled";
    embedder: "ok" | "failing";
  };
  /** Which vector backend is configured. The health page names the cold
   *  tier from this instead of assuming Qdrant, which mislabelled every
   *  pgvector deployment. `none` is unreachable through configuration —
   *  the server validates the provider as pgvector|qdrant — but the
   *  engine can be built without a cold tier, so the state exists. */
  coldProvider: "pgvector" | "qdrant" | "none";
}

export interface MetricsSnapshot {
  counters: {
    queries_total: number;
    queries_zero_hit: number;
    remembers_total: number;
    forgets_total: number;
    promotions_total: number;
    demotions_total: number;
    decay_runs_total: number;
    orphans_reaped_total: number;
    hits_warm_total: number;
    hits_cold_total: number;
    hits_graph_total: number;
  };
  gauges: {
    warm_entries: number | null;
    cold_entries: number | null;
    graph_edges: number | null;
    orphans_pending: number | null;
    last_decay_run_iso: string | null;
  };
  rates: {
    queries_per_sec_60s: number;
    remembers_per_sec_60s: number;
  };
  /** Per-token rates for the calling user's tokens. Only set when the
   *  snapshot was returned from /v1/me/metrics; admin /v1/admin/metrics
   *  has no notion of "my tokens". */
  tokens?: TokenMetricsRow[];
  uptime_ms: number;
}

export interface UserToken {
  tokenHash: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface Project {
  id: string;
  name: string;
  role: "owner" | "member";
  ownerUserId: string;
  createdAt: string;
}

export interface ProjectMember {
  userId: string;
  username: string;
  role: "owner" | "member";
  joinedAt: string;
}

export interface DashUser {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionUser {
  id: string;
  username: string;
  role: "admin" | "user";
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  csrfToken: string;
  needsPasswordChange: boolean;
  user: SessionUser;
}

export interface UserMetricsSnapshot {
  userId: string;
  counters: {
    queries_total: number;
    queries_zero_hit: number;
    remembers_total: number;
    forgets_total: number;
    hits_warm_total: number;
    hits_cold_total: number;
    hits_graph_total: number;
  };
  gauges: {
    warm_entries: number | null;
    cold_entries: number | null;
    graph_edges: number | null;
  };
  rates: {
    queries_per_sec_60s: number;
    remembers_per_sec_60s: number;
  };
  /** Per-token rolling rates — present on the /v1/me/metrics response so
   *  the dashboard can chart individual token usage alongside the total. */
  tokens?: TokenMetricsRow[];
  uptime_ms: number;
}

export interface TokenMetricsRow {
  tokenHash: string;
  label: string | null;
  counters: {
    queries_total: number;
    remembers_total: number;
    forgets_total: number;
  };
  rates: { queries_per_sec_60s: number; remembers_per_sec_60s: number };
}

export interface SearchResult {
  id: string;
  score: number;
  content: string;
  tier: "warm" | "cold";
  namespace: string;
  project: string | null;
  source: string;
  metadata: Record<string, unknown>;
  signals: { keyword: number; vector: number; graph: number };
}

export interface RecentEntry {
  id: string;
  content: string;
  namespace: string;
  source: string;
  tier: "warm" | "cold";
  hits: number;
  age: string;
  project: string | null;
  signals: { keyword: number; vector: number; graph: number };
  score: number;
  /** 0..1 fraction of the entry's "lifespan" remaining before decay
   *  promotes it. Computed by the server from hits + lastAccessed. */
  decay?: number;
}

export interface NeighborsResult {
  id: string;
  neighbors: Array<{ id: string; weight: number; tier: "warm" | "cold" }>;
}

export interface ActivityEvent {
  kind: "remember" | "token" | "project" | "audit";
  at: string;
  text: string;
  project: string | null;
}

export interface OnboardingState {
  bootstrapDone: boolean;
  userDone: boolean;
  mintedToken: boolean;
  remembered: boolean;
  userId: string;
}
