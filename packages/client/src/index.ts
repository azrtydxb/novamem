/**
 * NovamemClient — typed HTTP client for the novamem service. Works in
 * Node.js ≥ 20 and any modern browser (uses global fetch).
 *
 * Auth: the `token` option accepts either a tenant bearer (`nm_…`) for
 * data-plane calls or a dashboard session bearer (`ns_…`) for control-plane
 * calls (project CRUD, token mint, user-scoped operations). The wire format
 * is identical — `Authorization: Bearer <token>` — so the same client works
 * for both as long as the supplied token has the right scope.
 */

export interface NovamemClientOptions {
  baseUrl: string;
  /** Bearer token: tenant (`nm_…`) for data-plane calls, or session
   *  (`ns_…`) for dashboard control-plane calls. */
  token?: string;
  /** Optional fetch implementation override (useful for tests). */
  fetch?: typeof fetch;
}

export interface SearchRequest {
  query: string;
  k?: number;
  namespace?: string;
  agentName?: string | null;
  /** Project (sub-brain) to scope to. Omit for tenant-wide entries. */
  project?: string | null;
  weights?: { keyword?: number; vector?: number; graph?: number };
}

export interface SearchResult {
  id: string;
  score: number;
  content: string;
  tier: "warm" | "cold";
  namespace: string;
  /** Project this entry belongs to, or null for tenant-wide entries. */
  project: string | null;
  source: string;
  metadata: Record<string, unknown>;
  signals: { keyword: number; vector: number; graph: number };
}

export interface SearchResponse {
  results: SearchResult[];
  degraded: boolean;
}

export interface RememberRequest {
  content: string;
  namespace?: string;
  source?: string;
  agentName?: string | null;
  project?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RememberResponse {
  id: string;
}

export interface StatsResponse {
  byNamespace: Record<string, { warm: number; cold: number }>;
  totalWarm: number;
  totalCold: number;
  lastDecayAt: string | null;
  uptimeMs: number;
}

export interface HealthResponse {
  ok: boolean;
  deps: {
    warm: "ok" | "unreachable";
    cold: "ok" | "unreachable";
    graph: "ok" | "unreachable" | "disabled";
  };
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: { id: string; username: string; role: "admin" | "user"; tenantId: string | null };
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

export interface MintTokenResponse {
  token: string;
  tenantId: string;
  projectId: string | null;
  createdAt: string;
  warning: string;
}

export class NovamemClient {
  private readonly baseUrl: string;
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NovamemClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Replace the bearer in-place. Used after login() to upgrade a clientless
   *  instance to a session-authed one without throwing it away. */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (hasBody) h["content-type"] = "application/json";
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? "GET";
    const hasBody = init.body !== undefined;
    const r = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(hasBody),
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`novamem ${r.status}: ${text}`);
    }
    if (r.status === 204) return undefined as unknown as T;
    return (await r.json()) as T;
  }

  // ─── Data plane ────────────────────────────────────────────────────────

  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/search", { method: "POST", body: req });
  }

  async remember(req: RememberRequest): Promise<RememberResponse> {
    return this.request<RememberResponse>("/v1/remember", { method: "POST", body: req });
  }

  async today(opts: { namespace?: string; k?: number; project?: string | null } = {}): Promise<SearchResponse> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.recent({ ...opts, since });
  }

  async recent(opts: {
    namespace?: string;
    k?: number;
    since?: string;
    project?: string | null;
  } = {}): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/recent", { method: "POST", body: opts });
  }

  async neighbors(opts: {
    id: string;
    depth?: number;
    k?: number;
    project?: string | null;
  }): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/neighbors", { method: "POST", body: opts });
  }

  async forget(id: string, opts: { project?: string | null } = {}): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>("/v1/forget", {
      method: "POST",
      body: { id, ...opts },
    });
  }

  async stats(): Promise<StatsResponse> {
    return this.request<StatsResponse>("/v1/stats");
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health");
  }

  async decay(opts: { effectiveDays?: number } = {}): Promise<{ demoted: number; promoted: number }> {
    return this.request<{ demoted: number; promoted: number }>("/v1/decay", {
      method: "POST",
      body: opts,
    });
  }

  // ─── Auth (session control plane) ──────────────────────────────────────

  /** Sign in with username + password. Stores the returned session token on
   *  this client instance and returns the full response so callers can keep
   *  the token / user info. */
  async login(args: { username: string; password: string }): Promise<LoginResponse> {
    const res = await this.request<LoginResponse>("/v1/auth/login", {
      method: "POST",
      body: args,
    });
    this.token = res.token;
    return res;
  }

  /** Revoke the current session token server-side and clear it locally. */
  async logout(): Promise<void> {
    await this.request("/v1/auth/logout", { method: "POST" });
    this.token = undefined;
  }

  async me(): Promise<{ user: LoginResponse["user"] }> {
    return this.request<{ user: LoginResponse["user"] }>("/v1/auth/me");
  }

  // ─── Projects (sub-brains) — requires session bearer ───────────────────

  async listProjects(): Promise<{ projects: Project[] }> {
    return this.request<{ projects: Project[] }>("/v1/me/projects");
  }

  async createProject(args: { id: string; name: string }): Promise<Project> {
    return this.request<Project>("/v1/me/projects", { method: "POST", body: args });
  }

  async deleteProject(id: string): Promise<{
    deleted: boolean;
    entriesRemoved: number;
    coldCollectionsDropped: string[];
    graphCleared: boolean;
  }> {
    return this.request(`/v1/me/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listProjectMembers(id: string): Promise<{ members: ProjectMember[] }> {
    return this.request<{ members: ProjectMember[] }>(
      `/v1/me/projects/${encodeURIComponent(id)}/members`,
    );
  }

  async addProjectMember(
    id: string,
    args: { username: string; role?: "owner" | "member" },
  ): Promise<{ added: boolean; userId: string; username: string }> {
    return this.request(`/v1/me/projects/${encodeURIComponent(id)}/members`, {
      method: "POST",
      body: args,
    });
  }

  async removeProjectMember(id: string, userId: string): Promise<{ removed: boolean }> {
    return this.request(
      `/v1/me/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  // ─── Tokens (per-device API keys) — requires session bearer ────────────

  async mintToken(opts: { label?: string; projectId?: string | null } = {}): Promise<MintTokenResponse> {
    return this.request<MintTokenResponse>("/v1/me/tokens", { method: "POST", body: opts });
  }

  async listTokens(): Promise<{
    tokens: Array<{
      tokenHash: string;
      label: string | null;
      createdByUserId: string | null;
      projectId: string | null;
      createdAt: string;
      lastUsedAt: string | null;
      revoked: boolean;
    }>;
  }> {
    return this.request("/v1/me/tokens");
  }

  async revokeMyToken(tokenHash: string): Promise<{ revoked: boolean }> {
    return this.request(`/v1/me/tokens/${encodeURIComponent(tokenHash)}/revoke`, {
      method: "POST",
    });
  }
}
