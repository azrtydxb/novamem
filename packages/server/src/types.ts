/**
 * Public types for the novamem memory engine. These shapes are stable across
 * the HTTP API, MCP tools, and the @azrty/novamem TypeScript client.
 */

export interface MemoryEntry {
  id: string;
  content: string;
  namespace: string;
  source: string;
  agentName?: string | null;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  hits: number;
  lastAccessed: Date;
  createdAt: Date;
}

export interface SearchRequest {
  query: string;
  k?: number;
  namespace?: string;
  agentName?: string | null;
  /** Project (sub-brain) id. When omitted, scope is tenant-wide entries
   *  (entries with no project). When set, scope is just this project. */
  project?: string | null;
  /** Per-signal weights; defaults preserve NovaFlow's pre-extraction behaviour. */
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

export interface RememberRequest {
  content: string;
  namespace?: string;
  source?: string;
  agentName?: string | null;
  /** Project (sub-brain) id. Null/omitted = tenant-wide entry. */
  project?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DecayRequest {
  /** Override default decay schedule for a one-shot pass. */
  effectiveDays?: number;
}

export interface PromoteRequest {
  /** Minimum hit count to promote a cold entry back to warm. */
  minHits?: number;
}

export interface MemoryStats {
  byNamespace: Record<string, { warm: number; cold: number }>;
  totalWarm: number;
  totalCold: number;
  lastDecayAt: string | null;
  uptimeMs: number;
}

export interface HealthSnapshot {
  ok: boolean;
  deps: {
    warm: "ok" | "unreachable";
    cold: "ok" | "unreachable";
    graph: "ok" | "unreachable" | "disabled";
  };
}
