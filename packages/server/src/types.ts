/**
 * Public types for the novamem memory engine. These shapes are stable across
 * the HTTP API, MCP tools, and the @azrtydxb/novamem TypeScript client.
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
  /** Project (sub-brain) id. When omitted, scope is user-wide entries
   *  (entries with no project). When set, scope is just this project. */
  project?: string | null;
  /** Active-project mode: when set, scope expands to (user-wide entries) ∪
   *  (every listed project the caller is a member of). Membership is
   *  enforced upstream at the route layer. */
  includeProjects?: string[];
  /** Cross-namespace mode: union the search across these namespace
   *  shelves. When set, takes precedence over the singular `namespace`
   *  field. */
  includeNamespaces?: string[];
  /** Per-signal weights; defaults preserve NovaFlow's pre-extraction behaviour. */
  weights?: { keyword?: number; vector?: number; graph?: number };
}

export interface SearchResult {
  id: string;
  score: number;
  content: string;
  tier: "warm" | "cold";
  namespace: string;
  /** Project this entry belongs to, or null for user-wide entries. */
  project: string | null;
  source: string;
  metadata: Record<string, unknown>;
  /** Per-signal contributions for ranked results (search/neighbors).
   *  Omitted on ordered results (recent) where ranking doesn't apply —
   *  callers should distinguish "not applicable" from "scored zero".
   *  Engine.neighbors emits only the graph signal (others omitted). */
  signals?: { keyword?: number; vector?: number; graph?: number };
}

export interface RememberRequest {
  content: string;
  namespace?: string;
  source?: string;
  agentName?: string | null;
  /** Project (sub-brain) id. Null/omitted = user-wide entry. */
  project?: string | null;
  metadata?: Record<string, unknown>;
  /** Provenance: structured kind for "show me everything from email" -
   *  style filters. Recommended values: chat, email, code-review, doc,
   *  inference, observation, system, manual. Open string — operators may
   *  add their own. */
  sourceType?: string;
  /** Provenance: free-text identifier of the channel (agent name,
   *  conversation id, IP, etc.). */
  capturedFrom?: string;
  /** Caller-provided confidence 0..1; defaults to 1.0. Search filters
   *  can use it to drop low-confidence inferences. */
  confidence?: number;
  /** Bypass the worthiness filter. Use sparingly — when the agent or
   *  user explicitly asserted the entry should be saved. */
  force?: boolean;
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
