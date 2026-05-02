/** Thin wrapper around `fetch` that injects the dashboard session token
 *  from sessionStorage and returns a structured result. Never throws.
 *
 *  Sessions are minted by `POST /v1/auth/login`; the SPA stores the
 *  bearer here for the tab's lifetime. `setToken("")` revokes locally
 *  (server revocation is handled by `POST /v1/auth/logout`). */

const TOKEN_KEY = "novamem_session_token";

export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(t: string): void {
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
  else sessionStorage.removeItem(TOKEN_KEY);
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
  const tok = getToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
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
  uptime_ms: number;
}
