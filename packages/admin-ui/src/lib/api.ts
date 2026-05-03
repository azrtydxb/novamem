/** Thin wrapper around `fetch` for the dashboard SPA. Sessions live in
 *  an HttpOnly cookie set by `POST /v1/auth/login` so this module never
 *  touches the bearer; we just `credentials: "include"` and the browser
 *  attaches the cookie automatically. CSRF protection: server sets a
 *  JS-readable `novamem_csrf` cookie at login + on every /v1/auth/me;
 *  we read it and echo it back as X-CSRF-Token on state-changing
 *  requests. */

const CSRF_COOKIE = "novamem_csrf";
const CSRF_HEADER = "X-CSRF-Token";

/** Read the (signed) CSRF cookie value. @fastify/cookie signs cookies
 *  in the form `<value>.<sig>`; the SPA only needs to echo the whole
 *  cookie value back unchanged — the server unsigns on receipt. */
function readCsrfCookie(): string {
  const raw = document.cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${CSRF_COOKIE}=`));
  if (!raw) return "";
  return decodeURIComponent(raw.slice(CSRF_COOKIE.length + 1));
}

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  body: T | null;
  error: string | null;
}

export async function api<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  // Only declare content-type when there's a body — Fastify's JSON parser
  // 400s on `content-type: application/json` with empty payload.
  if (body !== undefined && body !== null) headers["content-type"] = "application/json";
  // Echo back the CSRF cookie on state-changing requests. Bearer-auth
  // callers (CLI / MCP) skip this entirely; for the SPA the cookie is
  // present whenever there's an active session.
  const isStateChanging = method === "POST" || method === "DELETE";
  if (isStateChanging) {
    const csrf = readCsrfCookie();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }
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
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      errMsg = text.slice(0, 200);
    }
  }
  if (!res.ok && parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
    errMsg = String((parsed as Record<string, unknown>).error);
  }
  return { status: res.status, ok: res.ok, body: parsed, error: errMsg };
}

// ─── Typed shapes ──────────────────────────────────────────────────────

export interface HealthSnapshot {
  ok: boolean;
  deps: {
    warm: "ok" | "unreachable" | "disabled";
    cold: "ok" | "unreachable" | "disabled";
    graph: "ok" | "unreachable" | "disabled";
  };
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

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}

export interface TenantToken {
  tokenHash: string;
  label: string | null;
  createdByUserId: string | null;
  projectId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface Project {
  id: string;
  name: string;
  role: "owner" | "member";
  ownerUserId: string;
  ownerTenantId: string;
  createdAt: string;
}

export interface ProjectMember {
  userId: string;
  username: string;
  tenantId: string | null;
  role: "owner" | "member";
  joinedAt: string;
}

export interface DashUser {
  id: string;
  username: string;
  role: "admin" | "user";
  tenantId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionUser {
  id: string;
  username: string;
  role: "admin" | "user";
  tenantId: string | null;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export interface TenantMetricsSnapshot {
  tenantId: string;
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
  counters: { queries_total: number; remembers_total: number; forgets_total: number };
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
  tenantDone: boolean;
  mintedToken: boolean;
  remembered: boolean;
  tenantId: string;
}
