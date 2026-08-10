/**
 * Public types for the novamem memory engine. These shapes are stable across
 * the HTTP API, MCP tools, and the @azrtydxb/novamem TypeScript client.
 */

export type SensitivityLevel = "public" | "internal" | "private" | "sensitive";

export type MemoryType =
  | "user_preference"
  | "setup_fact"
  | "project_convention"
  | "decision"
  | "bug_root_cause"
  | "deployment_state"
  | "safety_constraint"
  | "general";

export interface WorthinessScore {
  durable: number;
  reuseLikelihood: number;
  userRelevance: number;
  confidence: number;
  overall: number;
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
  /** Per-signal weights; defaults preserve NovaFlow's pre-extraction behaviour.
   *  `recency` and `entity` are arch-plan Phase 1 additions. */
  weights?: {
    keyword?: number;
    vector?: number;
    graph?: number;
    recency?: number;
    entity?: number;
  };
  /** Maximum sensitivity returned. Defaults to private, excluding sensitive entries unless explicitly requested. */
  maxSensitivity?: SensitivityLevel;
  /** Arch-plan Phase 3: bitemporal as-of query — filter graph edges to
   *  those valid at this ISO 8601 instant. Default null = no filter. */
  asOf?: string | null;
  /** Arch-plan Phase 4: opt-in query decomposition + coherence rerank.
   *  Requires the engine to be configured with a decomposer; otherwise
   *  ignored. */
  decompose?: boolean;
  /** Arch-plan gap-closer: when a result is an extracted-fact memory,
   *  populate `metadata.sourceText` with its source chunk's content
   *  (looked up via metadata.source_chunk_id). Lets answerer LLMs see
   *  both the compressed fact and the supporting raw conversation.
   *  Default true. */
  expandSourceChunks?: boolean;
  /** Absolute cosine floor below which a vector-only candidate is treated
   *  as noise rather than a hit. Defaults to the server's configured
   *  value (NOVAMEM_SEARCH_MIN_VECTOR_SCORE, default 0.25). Pass 0 to
   *  disable and see every nearest neighbour. */
  minVectorScore?: number;
  /** Phase 5 EXPERIMENT: opt-in second-pass cross-encoder rerank of the
   *  candidate pool before selection. Requires the server to be
   *  configured with a rerank service (NOVAMEM_RERANK_*); otherwise
   *  ignored, like `decompose`. */
  rerank?: boolean;
  /** Cap the returned set at roughly this many tokens of content.
   *
   *  `k` bounds the number of results, which is not the thing a caller
   *  needs to control: the same k can cost 500 or 7,500 tokens depending
   *  only on whether the store holds one-line facts or conversation
   *  chunks. When set, results are admitted in score order until the
   *  budget is spent (the top hit is always returned, even if it alone
   *  exceeds the budget). `k` still applies as an upper bound. */
  maxTokens?: number;
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
  /** Privacy classification. Also stored in metadata.sensitivity. Defaults to inferred content sensitivity, then private. */
  sensitivity?: SensitivityLevel;
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
  /** Readiness. Covers warm + cold only — see the asymmetry note in
   *  `MemoryEngine.health()` for why a failing embedder is reported but
   *  never removes the service from rotation. */
  ok: boolean;
  deps: {
    warm: "ok" | "unreachable";
    cold: "ok" | "unreachable";
    graph: "ok" | "unreachable" | "disabled";
    /** "failing" when the embedder's most recent call threw. New writes
     *  are still accepted; they land with no vector and queue for the
     *  reconciler. */
    embedder: "ok" | "failing";
  };
  /** Entries awaiting a vector as of the last reconciler tick; null before
   *  the first tick. A number that stops falling means the queue is stuck. */
  pendingEmbeddings: number | null;
}
