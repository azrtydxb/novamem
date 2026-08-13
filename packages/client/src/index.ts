/**
 * NovamemClient — typed HTTP client for the novamem service. Works in
 * Node.js ≥ 20 and any modern browser (uses global fetch).
 *
 * Auth: the `token` option carries the caller's bearer (`nm_…`). Tokens
 * are user-owned and grant every right the owning user has — data plane,
 * project CRUD, membership, metrics, audit log. Wire format:
 * `Authorization: Bearer <token>`.
 */

export interface NovamemClientOptions {
  baseUrl: string;
  /** User-owned bearer (`nm_…`). Carries every right the owning user has. */
  token?: string;
  /** Optional fetch implementation override (useful for tests). */
  fetch?: typeof fetch;
}

export type SensitivityLevel = "public" | "internal" | "private" | "sensitive";

export interface SearchRequest {
  query: string;
  k?: number;
  namespace?: string;
  agentName?: string | null;
  /** Project (sub-brain) to scope to. Omit for user-wide entries. */
  project?: string | null;
  weights?: { keyword?: number; vector?: number; graph?: number };
  includeProjects?: string[];
  includeNamespaces?: string[];
  maxSensitivity?: SensitivityLevel;
  /** "snippet" truncates content to ~240 chars; "ids" omits content and
   *  metadata. For rank-first-hydrate-later callers. Default "full". */
  contentMode?: "full" | "snippet" | "ids";
}

export interface SearchResult {
  id: string;
  score: number;
  /** Absent when the request used contentMode: "ids". Possibly truncated
   *  (see `truncated`) under contentMode: "snippet". */
  content?: string;
  tier: "warm" | "cold";
  namespace: string;
  /** Project this entry belongs to, or null for user-wide entries. */
  project: string | null;
  source: string;
  /** Absent when the request used contentMode: "ids". */
  metadata?: Record<string, unknown>;
  /** Per-signal contributions for ranked results (search/neighbors).
   *  Omitted on ordered results (recent) where ranking isn't applicable. */
  signals?: { keyword?: number; vector?: number; graph?: number };
  /** Present (true) when contentMode: "snippet" cut this content. */
  truncated?: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  degraded: boolean;
}

export interface ContextRequest {
  message: string;
  k?: number;
  namespace?: string;
  project?: string | null;
  includeProjects?: string[];
  includeNamespaces?: string[];
  weights?: { keyword?: number; vector?: number; graph?: number };
  maxSensitivity?: SensitivityLevel;
}

export interface ContextPack {
  userGlobal: SearchResult[];
  projectScoped: SearchResult[];
  userPreferences: SearchResult[];
  currentSetup: SearchResult[];
  projectConventions: SearchResult[];
  decisions: SearchResult[];
  bugRootCauses: SearchResult[];
  deploymentState: SearchResult[];
  safetyConstraints: SearchResult[];
  pitfalls: SearchResult[];
  recentDecisions: SearchResult[];
  all: SearchResult[];
}

export interface ContextResponse {
  relevant: SearchResponse;
  recent: { results: SearchResult[] };
  contextPack?: ContextPack;
  guidance: string;
}

export interface RememberRequest {
  content: string;
  namespace?: string;
  source?: string;
  agentName?: string | null;
  project?: string | null;
  metadata?: Record<string, unknown>;
  sensitivity?: SensitivityLevel;
  sourceType?: string;
  capturedFrom?: string;
  confidence?: number;
  force?: boolean;
  /** Explicit TTL (ISO-8601). Past it the entry is hidden from reads
   *  immediately and hard-deleted by the server's decay-timer reaper. */
  expiresAt?: string;
}

/**
 * What `/v1/capture` and `/v1/remember` actually return (201). `id` is
 * null when the worthiness gate rejected the content — `rejected` then
 * carries the reason, and nothing was stored.
 *
 * (This type previously described `/v1/session-recap`'s `{saved, results}`
 * envelope, which is a different endpoint — see `SessionRecapResponse`.)
 */
export interface CaptureResponse {
  id: string | null;
  /** Reason the worthiness gate refused the write. Present ⇒ `id` is null. */
  rejected?: string;
  /** The content already existed; `id` points at the pre-existing entry. */
  deduplicated?: boolean;
  /** A near-duplicate was rewritten in place rather than inserted. */
  updated?: boolean;
  /** Entries this write marked superseded (it contradicted them). */
  superseded?: string[];
  /**
   * Whether the entry has a vector yet. `false` means it is stored and
   * durable but **not findable by semantic search** until the server's
   * reconciler catches up — keyword and graph search still reach it.
   * Absent on responses from servers predating this field.
   */
  embedded?: boolean;
}

/** `/v1/session-recap` — one capture per item, wrapped in a count. */
export interface SessionRecapResponse {
  saved: number;
  results: CaptureResponse[];
}

export interface SessionRecapRequest {
  decisions?: string[];
  setupFacts?: string[];
  rootCauses?: string[];
  preferences?: string[];
  projectConventions?: string[];
  safetyConstraints?: string[];
  other?: string[];
  namespace?: string;
  source?: string;
  sourceType?: string;
  capturedFrom?: string;
  agentName?: string | null;
  confidence?: number;
  force?: boolean;
  project?: string | null;
  metadata?: Record<string, unknown>;
  sensitivity?: SensitivityLevel;
}

/** `/v1/remember` shares `/v1/capture`'s result shape. */
export type RememberResponse = CaptureResponse;

export interface UpdateRequest {
  content?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
  sourceType?: string;
  capturedFrom?: string;
  confidence?: number;
  project?: string | null;
  sensitivity?: SensitivityLevel;
}

export interface AdoptionRequest {
  client?: string;
  observedTools?: string[];
  observedInstructionsHash?: string;
}

export interface AdoptionResponse {
  server: { name: string; adoptionSchema: number };
  mcp: { toolCount: number; tools: string[]; instructionsHash: string; instructionsPreview: string; listChanged: boolean };
  requiredTools: string[];
  features: Record<string, boolean>;
  refresh: Record<string, { commands: string[]; requiresNewSession: boolean; note: string }>;
  requestedClient: string;
  diagnostics: Array<{ check: string; ok: boolean; action: string; [key: string]: unknown }>;
}

export interface HygieneResponse {
  lowValue: unknown[];
  stale: unknown[];
  duplicateClusters: unknown[];
  contradictionCandidates: unknown[];
  orphanCandidates: unknown[];
}

export interface EvaluateResponse {
  suite: string;
  summary: { total: number; passed: number; failed: number };
  cases: Array<{ name: string; passed: boolean }>;
}

export interface StatsResponse {
  byNamespace: Record<string, { warm: number; cold: number }>;
  totalWarm: number;
  totalCold: number;
  lastDecayAt: string | null;
  uptimeMs: number;
}

/**
 * Public `/health` is boolean-only by design — no infrastructure detail
 * leaks to unauthenticated callers. Per-dependency status lives behind the
 * admin-gated `/v1/admin/health/deep` route, which this client does not
 * expose.
 */
export interface HealthResponse {
  ok: boolean;
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

export interface MintTokenResponse {
  token: string;
  scope: "full" | "read_only";
  projectId: string | null;
  expiresAt: string | null;
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
   *  instance to an authed one without throwing it away. */
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
      // The server uses a uniform error shape: {error, code?, issues?}.
      // Try JSON first so callers see the structured `code` (e.g.
      // LAST_ADMIN_PROTECTED) when present; fall back to raw text.
      const text = await r.text();
      let suffix = text;
      try {
        const parsed = JSON.parse(text) as { error?: string; code?: string };
        if (parsed && typeof parsed === "object") {
          const msg = parsed.error ?? text;
          suffix = parsed.code ? `${msg} [${parsed.code}]` : msg;
        }
      } catch {
        // not JSON — keep raw text
      }
      throw new Error(`novamem ${r.status}: ${suffix}`);
    }
    if (r.status === 204) return undefined as unknown as T;
    return (await r.json()) as T;
  }

  // ─── Data plane ────────────────────────────────────────────────────────

  /**
   * Hybrid search. Throws on 503, which the server returns when a backing
   * tier failed *and* produced nothing — that is "I could not look", not
   * "I found nothing", and the two must not collapse into an empty array.
   * A 200 with `degraded: true` means the results are real but possibly
   * incomplete.
   */
  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/search", { method: "POST", body: req });
  }

  async context(req: ContextRequest): Promise<ContextResponse> {
    return this.request<ContextResponse>("/v1/context", { method: "POST", body: req });
  }

  async hygiene(req: { k?: number } = {}): Promise<HygieneResponse> {
    return this.request<HygieneResponse>("/v1/hygiene", { method: "POST", body: req });
  }

  async evaluate(req: { suite?: string } = {}): Promise<EvaluateResponse> {
    return this.request<EvaluateResponse>("/v1/evaluate", { method: "POST", body: req });
  }

  async adoption(req: AdoptionRequest = {}): Promise<AdoptionResponse> {
    return this.request<AdoptionResponse>("/v1/adoption", { method: "POST", body: req });
  }

  async capture(req: RememberRequest): Promise<CaptureResponse> {
    return this.request<CaptureResponse>("/v1/capture", { method: "POST", body: req });
  }

  async sessionRecap(req: SessionRecapRequest): Promise<SessionRecapResponse> {
    return this.request<SessionRecapResponse>("/v1/session-recap", { method: "POST", body: req });
  }

  async remember(req: RememberRequest): Promise<RememberResponse> {
    return this.request<RememberResponse>("/v1/remember", { method: "POST", body: req });
  }

  async today(opts: { namespace?: string; includeNamespaces?: string[]; maxSensitivity?: SensitivityLevel; k?: number; project?: string | null; includeProjects?: string[] } = {}): Promise<SearchResponse> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.recent({ ...opts, since });
  }

  async recent(opts: {
    namespace?: string;
    includeNamespaces?: string[];
    maxSensitivity?: SensitivityLevel;
    k?: number;
    since?: string;
    project?: string | null;
    includeProjects?: string[];
    contentMode?: "full" | "snippet" | "ids";
  } = {}): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/recent", { method: "POST", body: opts });
  }

  async neighbors(opts: {
    id: string;
    depth?: number;
    k?: number;
    project?: string | null;
    includeProjects?: string[];
  }): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/neighbors", { method: "POST", body: opts });
  }

  async update(id: string, req: UpdateRequest): Promise<{ updated: boolean }> {
    return this.request<{ updated: boolean }>(`/v1/memories/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: req,
    });
  }

  /**
   * Delete an entry. Check **both** fields: `coldDeleteOk: false` means the
   * warm row is gone but the vector copy survived (the server queued it for
   * its reaper), so the deletion is not yet complete. Deletion is a promise
   * to a person; reporting a half-completed one as done is how that promise
   * gets quietly broken.
   */
  async forget(
    id: string,
    opts: { project?: string | null } = {},
  ): Promise<{ deleted: boolean; coldDeleteOk: boolean }> {
    return this.request<{ deleted: boolean; coldDeleteOk: boolean }>("/v1/forget", {
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

  async decay(opts: { effectiveDays?: number } = {}): Promise<{ demoted: number; promoted: number; expired: number }> {
    return this.request<{ demoted: number; promoted: number; expired: number }>("/v1/decay", {
      method: "POST",
      body: opts,
    });
  }

  // (Sign-in / sign-out / me are owned by Better Auth at /api/auth/*.
  // The dashboard SPA calls them directly. Non-browser callers should
  // mint a bearer via `/v1/me/tokens` (or the dashboard's API Tokens
  // page) and pass it to the constructor's `token` option.)

  // ─── Projects (sub-brains) ─────────────────────────────────────────────

  async listProjects(): Promise<{ projects: Project[] }> {
    return this.request<{ projects: Project[] }>("/v1/me/projects");
  }

  /** Create a new project. The id is server-assigned (ULID). */
  async createProject(args: { name: string }): Promise<Project> {
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

  /** Convenience for the MCP shim: remove a member by their handle as it
   *  appears in the members listing (the `username` column, which the
   *  server populates from the user's email). Resolves to an id via the
   *  members listing rather than exposing a separate user-lookup API. */
  async removeProjectMemberByUsername(
    project: string,
    username: string,
  ): Promise<{ removed: boolean }> {
    const { members } = await this.listProjectMembers(project);
    const target = members.find((m) => m.username === username);
    if (!target) throw new Error(`unknown member '${username}'`);
    return this.removeProjectMember(project, target.userId);
  }

  // ─── Active project ────────────────────────────────────────────────────

  async getActiveProject(): Promise<{ active: { id: string; name: string } | null }> {
    return this.request<{ active: { id: string; name: string } | null }>(
      "/v1/me/active-project",
    );
  }

  async setActiveProject(project: string): Promise<{ active: { id: string } }> {
    return this.request<{ active: { id: string } }>("/v1/me/active-project", {
      method: "PUT",
      body: { project },
    });
  }

  async clearActiveProject(): Promise<void> {
    await this.request("/v1/me/active-project", { method: "DELETE" });
  }

  /** Page the caller's memory changelog. Pass the previous page's
   *  `nextSeq` back as `afterSeq` to resume without missing events.
   *  Best-effort log (see server docs) — certainty requires a full diff. */
  async changes(opts: { since?: string; afterSeq?: number; limit?: number } = {}): Promise<{
    changes: Array<{
      seq: number;
      entryId: string;
      projectId: string | null;
      change: "created" | "updated" | "superseded" | "deleted" | "expired";
      detail: Record<string, unknown> | null;
      at: string;
    }>;
    nextSeq: number | null;
  }> {
    const qs = new URLSearchParams();
    if (opts.since) qs.set("since", opts.since);
    if (opts.afterSeq !== undefined) qs.set("afterSeq", String(opts.afterSeq));
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const suffix = qs.size > 0 ? `?${qs}` : "";
    return this.request(`/v1/me/changes${suffix}`);
  }

  // ─── Tokens (per-device API keys) ──────────────────────────────────────

  /** Mint a bearer. `scope: "read_only"` limits it to reads; `project`
   *  confines it to one project (id or name); `expiresInDays` sets a hard
   *  expiry. Restricted tokens cannot mint, rotate into broader tokens,
   *  or reach /v1/admin/*. */
  async mintToken(
    opts: {
      label?: string;
      scope?: "full" | "read_only";
      project?: string;
      expiresInDays?: number;
    } = {},
  ): Promise<MintTokenResponse> {
    return this.request<MintTokenResponse>("/v1/me/tokens", { method: "POST", body: opts });
  }

  async listTokens(): Promise<{
    tokens: Array<{
      tokenHash: string;
      label: string | null;
      scope: "full" | "read_only";
      projectId: string | null;
      expiresAt: string | null;
      createdAt: string;
      lastUsedAt: string | null;
      revoked: boolean;
    }>;
  }> {
    return this.request("/v1/me/tokens");
  }

  /** Hard-delete a bearer by sha256 hash. Wire route is
   *  `DELETE /v1/me/tokens/:hash`. */
  async revokeMyToken(tokenHash: string): Promise<{ deleted: boolean }> {
    return this.request(`/v1/me/tokens/${encodeURIComponent(tokenHash)}`, {
      method: "DELETE",
    });
  }
}
