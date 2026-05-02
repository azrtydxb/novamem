/**
 * NovamemClient — typed HTTP client for the novamem service. Works in
 * Node.js ≥ 20 and any modern browser (uses global fetch).
 */

export interface NovamemClientOptions {
  baseUrl: string;
  /** Bearer token for `auth.mode = bearer` deployments. */
  token?: string;
  /** Optional fetch implementation override (useful for tests). */
  fetch?: typeof fetch;
}

export interface SearchRequest {
  query: string;
  k?: number;
  namespace?: string;
  agentName?: string | null;
  weights?: { keyword?: number; vector?: number; graph?: number };
}

export interface SearchResult {
  id: string;
  score: number;
  content: string;
  tier: "warm" | "cold";
  namespace: string;
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

export class NovamemClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NovamemClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
    if (!r.ok) throw new Error(`novamem ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/search", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async remember(req: RememberRequest): Promise<RememberResponse> {
    return this.request<RememberResponse>("/v1/remember", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async today(opts: { namespace?: string; k?: number } = {}): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "*", ...opts }),
    });
  }

  async recent(opts: { namespace?: string; k?: number; since?: string } = {}): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/recent", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  async neighbors(opts: { id: string; depth?: number; k?: number }): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/neighbors", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  async forget(id: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>("/v1/forget", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  async stats(): Promise<StatsResponse> {
    return this.request<StatsResponse>("/v1/stats");
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health");
  }

  async decay(opts: { effectiveDays?: number } = {}): Promise<{ demoted: number }> {
    return this.request<{ demoted: number }>("/v1/decay", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  // promote() — cold→warm promotion is not yet implemented.
  // Track the issue: cold entries surface in search results with tier:"cold";
  // re-promotion logic will land alongside the candidate-tracker feature.
}
