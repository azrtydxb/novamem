/**
 * MemoryEngine — the synchronous TypeScript core. Both the HTTP and MCP
 * adapters compose this same object.
 */

import { createHash } from "node:crypto";

import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";

import { ColdStore } from "../cold-store.js";
import { GraphStore } from "../graph-store.js";
import { WarmStore } from "../warm-store/index.js";
import type { Embedder } from "../embeddings.js";
import type { MetricsCollector, TokenIdentity } from "../admin/metrics.js";
import type {
  HealthSnapshot,
  MemoryStats,
  MemoryType,
  ContextPack,
  RememberRequest,
  SearchRequest,
  SensitivityLevel,
  SearchResult,
} from "../types.js";
import {
  DEFAULT_MIN_VECTOR_SCORE,
  DEFAULT_WEIGHTS,
  effectiveDays,
  EFFECTIVE_LIFESPAN_SQL,
  entityMatchScore,
  extractQueryEntities,
  fuse,
  rankPrior,
  recencyScore,
} from "./hybrid-search.js";
import { traceAsync } from "../tracing.js";

/** Stable hash of normalized content. Used by the worthiness gate to
 *  detect exact duplicates within a (user, project) scope. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Lowercased English-stopword shortlist for `tokenJaccard`. Kept small
 *  and conservative — the goal is to drop the high-frequency glue words
 *  ("the", "in", "is", …) that otherwise let near-contradictions clear
 *  the dream cycle's 0.5 threshold. Identifiers and content words stay. */
const JACCARD_STOPWORDS = new Set([
  "a", "an", "the",
  "i", "you", "he", "she", "it", "we", "they",
  "me", "my", "your", "his", "her", "our", "their",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "have", "has", "had",
  "to", "of", "in", "on", "at", "by", "for", "from", "with", "as",
  "and", "or", "but", "if", "so", "than", "that", "this",
  "not", "no", "nor",
]);

/** Token-set Jaccard similarity, lowercased and stop-word-filtered. Used
 *  by the dream cycle to gate vector-similarity merges — a high cosine
 *  alone isn't enough; the texts also have to share content-word
 *  surface area or we'd merge contradictions like "Pascal lives in
 *  Dubai" with "Pascal lives in Belgium" (which share only the glue
 *  words `i`/`in`/`live` — exactly what the stopword filter strips). */
function contentTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (JACCARD_STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** True when `next` carries every content word `prev` had — i.e. the new
 *  text restates or refines the old one without dropping anything.
 *
 *  This is the gate `capture()` uses before overwriting a memory in
 *  place, and it is deliberately stricter than a similarity threshold.
 *  Cosine — and even token-set Jaccard — cannot distinguish "same fact,
 *  said again" from "different fact, said the same way": "wife's
 *  birthday is May 3" and "daughter's birthday is May 3" sit above the
 *  0.92 semantic-duplicate threshold *and* above a 0.5 Jaccard
 *  threshold (they share `s`, `birthday`, `may`, `3` — overlap 0.67),
 *  yet overwriting one with the other destroys a fact that was never
 *  restated.
 *
 *  Subset containment answers the question that actually matters: is any
 *  information being dropped? If the old text has a content word the new
 *  one lacks, the new text is not a restatement of it, so we store both
 *  and let supersession (or the agent) resolve it. Nothing is ever lost
 *  silently. */
export function isContentSuperset(prev: string, next: string): boolean {
  const a = contentTokens(prev);
  const b = contentTokens(next);
  if (a.size === 0) return true;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/** Jaccard over pre-tokenised sets. Split out from `tokenJaccard` so
 *  callers that compare one text against many (the search-result
 *  diversity filter) can tokenise each text once instead of per pair. */
function jaccardOf(ta: Set<string>, tb: Set<string>): number {
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  const union = ta.size + tb.size - intersect;
  return intersect / union;
}

export function tokenJaccard(a: string, b: string): number {
  return jaccardOf(contentTokens(a), contentTokens(b));
}

const SEMANTIC_DUPLICATE_THRESHOLD = 0.92;
const CAPTURE_CANDIDATE_K = 5;
/** Words that look like entities by capitalisation but carry no identity —
 *  sentence openers and calendar words dominate this list. */
const ENTITY_STOPWORDS = new Set([
  "the", "a", "an", "i", "we", "he", "she", "it", "they", "you",
  "this", "that", "these", "those", "there", "here", "then", "when", "while",
  "if", "and", "but", "or", "so", "also", "however", "after", "before",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
  "today", "tomorrow", "yesterday", "now", "note", "notes", "todo",
  "use", "used", "using", "set", "add", "added", "new", "old",
]);

/** Extract identity-bearing tokens from memory content.
 *
 *  The graph tier was previously a pure echo of the vector tier: its only
 *  edges were `co_occurs` links to the top-N vector neighbours at write
 *  time, so traversing it could never surface anything embeddings had not
 *  already found. That made its 0.1 weight close to redundant.
 *
 *  Entities give the graph an orthogonal signal — exact identifier
 *  bridging, which is precisely what embeddings are worst at. Two
 *  memories mentioning `novanas` or `PostgreSQL` are connected even when
 *  their prose is dissimilar, so a query naming an entity can reach
 *  memories that neither cosine nor stemmed FTS would rank.
 *
 *  Deliberately heuristic and dependency-free rather than an NLP model or
 *  an LLM call: this runs on every write, and a cheap high-precision
 *  extractor beats an expensive high-recall one when the output is a
 *  ranking *hint* rather than an answer. Four shapes, all high-signal:
 *    - code identifiers (snake_case, kebab-case, dotted paths, CamelCase)
 *    - capitalised words that aren't sentence-opening stopwords
 *    - versioned product names (postgres16, node24)
 *    - anything in backticks or quotes, which in technical prose is
 *      almost always an identifier
 *
 *  Precision is chosen over recall on purpose. A *bare lowercase* word
 *  like `novanas` is not extracted, because no cheap rule separates it
 *  from `cluster`, `target`, or `deployment` — admitting those would wire
 *  every memory to every other through common nouns and turn the entity
 *  signal into noise. Bare lowercase terms are already served well by the
 *  keyword tier, which matches them exactly; the entity graph exists to
 *  cover what FTS and embeddings both miss, not to duplicate FTS. Writing
 *  such a term capitalised or in backticks opts it in. */
export function extractEntities(content: string, max = 12): string[] {
  const found = new Map<string, string>();
  const add = (raw: string) => {
    const key = raw.toLowerCase();
    if (key.length < 3 || key.length > 64) return;
    if (ENTITY_STOPWORDS.has(key)) return;
    if (!found.has(key)) found.set(key, raw);
  };

  // Code-ish identifiers: contain an internal separator or interior caps.
  for (const m of content.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)+\b/g)) {
    add(m[0]);
  }
  for (const m of content.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) add(m[0]);
  // Capitalised words not at a position we can prove is sentence-initial;
  // the stopword list removes the common false positives.
  for (const m of content.matchAll(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)) add(m[0]);
  // Product+version tokens.
  for (const m of content.matchAll(/\b[a-zA-Z]{3,}\d+(?:\.\d+)*\b/g)) add(m[0]);
  // Backticked / quoted spans — in technical prose these are identifiers
  // far more often than not, and they let an author opt a bare lowercase
  // term into the entity graph explicitly.
  for (const m of content.matchAll(/[`"']([A-Za-z][A-Za-z0-9._/-]{2,63})[`"']/g)) {
    if (m[1]) add(m[1]);
  }

  return [...found.keys()].slice(0, max);
}

/** `engine_state` key holding the dream cycle's table-walk cursor. */
const DREAM_CURSOR_KEY = "dream_cycle_cursor";

/** `engine_state` key holding the embedding model id that produced the
 *  vectors currently in the cold store. */
const EMBEDDING_MODEL_KEY = "embedding_model_id";

/** How many of the top vector hits seed the graph traversal. */
const GRAPH_SEED_COUNT = 3;
/** Candidates fetched per requested result, so post-fusion visibility
 *  filtering and diversification have material to work with. */
const OVERFETCH_FACTOR = 3;
/** Two results whose token sets overlap at least this much are treated as
 *  restatements of one another; only the higher-ranked one is returned. */
const RESULT_DIVERSITY_MAX_JACCARD = 0.75;

/** Ceiling on how many candidates the coherence reranker is shown. The
 *  prompt inlines 600 chars each and asks for a permutation back within a
 *  200-token budget, so the list has to stay small enough for the model to
 *  actually enumerate. Reranking beyond the caller's k is wasted work in
 *  any case. */
const COHERENCE_RERANK_MAX_CANDIDATES = 40;

const SENSITIVITY_ORDER: Record<SensitivityLevel, number> = { public: 0, internal: 1, private: 2, sensitive: 3 };
const DEFAULT_MAX_SENSITIVITY: SensitivityLevel = "private";

function normalizeSensitivity(value: unknown): SensitivityLevel | undefined {
  return ["public", "internal", "private", "sensitive"].includes(String(value))
    ? (String(value) as SensitivityLevel)
    : undefined;
}

function inferSensitivity(content: string, metadata?: Record<string, unknown>, explicit?: SensitivityLevel): SensitivityLevel {
  const fromExplicit = normalizeSensitivity(explicit);
  if (fromExplicit) return fromExplicit;
  const fromMetadata = normalizeSensitivity(metadata?.sensitivity);
  if (fromMetadata) return fromMetadata;
  if (/\b(api[_ -]?key|token|secret|password|private[_ -]?key|bearer|sk-[a-z0-9_-]{8,})\b/i.test(content)) return "sensitive";
  return "private";
}

function withSensitivityMetadata(req: RememberRequest): RememberRequest {
  const sensitivity = inferSensitivity(req.content, req.metadata, req.sensitivity);
  return { ...req, metadata: { ...(req.metadata ?? {}), sensitivity } };
}

function resultSensitivity(metadata: Record<string, unknown> | null | undefined): SensitivityLevel {
  return normalizeSensitivity(metadata?.sensitivity) ?? "private";
}

function isSensitivityVisible(metadata: Record<string, unknown> | null | undefined, maxSensitivity?: SensitivityLevel): boolean {
  const max = normalizeSensitivity(maxSensitivity) ?? DEFAULT_MAX_SENSITIVITY;
  return SENSITIVITY_ORDER[resultSensitivity(metadata)] <= SENSITIVITY_ORDER[max];
}


function metadataStatus(metadata: Record<string, unknown> | null | undefined): string {
  const status = metadata?.lifecycleStatus;
  return typeof status === "string" ? status : "active";
}

function isInactiveMemory(metadata: Record<string, unknown> | null | undefined): boolean {
  if (["superseded", "deprecated"].includes(metadataStatus(metadata))) return true;
  // Arch-plan Phase 2 v2 (Mem0 updation): facts that lost a write-time
  // DELETE decision get `fact_inactive: true` and stay in the warm row
  // for history-preservation but must drop out of search results.
  if ((metadata as Record<string, unknown> | null | undefined)?.fact_inactive) return true;
  return false;
}

function extractComparableScalars(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(/\b\d+(?:\.\d+)?\b/g)) out.add(`num:${m[0]}`);
  for (const m of content.matchAll(/\bv?\d+(?:\.\d+){1,}\b/gi)) out.add(`ver:${m[0].toLowerCase()}`);
  for (const m of content.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) out.add(`date:${m[0]}`);
  for (const m of content.matchAll(/\b(?:port|:|endpoint\s+[^\s:]+:)\s*(\d{2,5})\b/gi)) out.add(`port:${m[1]}`);
  for (const m of content.matchAll(/\bsha[-_:]?[a-z0-9]{6,}\b/gi)) out.add(`sha:${m[0].toLowerCase()}`);
  for (const m of content.matchAll(/\bmodel\s+([a-z0-9._\/-]+)\b/gi)) if (m[1]) out.add(`model:${m[1].toLowerCase()}`);
  for (const m of content.matchAll(/\b(?:image|container)\s+([a-z0-9._\/:-]+)\b/gi)) if (m[1]) out.add(`image:${m[1].toLowerCase()}`);
  return out;
}

function hasExplicitNegation(content: string): boolean {
  return /\b(no|not|never|disabled|inactive|false|off|without|stopped|removed|deprecated)\b/i.test(content);
}

function looksContradictory(oldContent: string, newContent: string): boolean {
  const oldScalars = extractComparableScalars(oldContent);
  const newScalars = extractComparableScalars(newContent);
  if (oldScalars.size > 0 && newScalars.size > 0) {
    const oldOnly = [...oldScalars].some((v) => !newScalars.has(v));
    const newOnly = [...newScalars].some((v) => !oldScalars.has(v));
    if (oldOnly && newOnly) return true;
  }
  return hasExplicitNegation(oldContent) !== hasExplicitNegation(newContent);
}

function mergeCaptureMetadata(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | undefined,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(patch ?? {}),
    lifecycleStatus: "active",
    ...extra,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(3))));
}

/** The closed set of memory types. Exported so the route schemas and the
 *  metadata validator agree on one list instead of drifting. */
export const MEMORY_TYPES = [
  "user_preference",
  "bug_root_cause",
  "decision",
  "deployment_state",
  "setup_fact",
  "project_convention",
  "safety_constraint",
  "general",
] as const;

function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

export function inferMemoryType(content: string, namespace?: string, metadata?: Record<string, unknown>): MemoryType {
  // Caller-supplied `metadata.memoryType` used to be cast straight to
  // MemoryType, so any arbitrary string became a "type" and flowed into
  // retention-policy selection, where it silently fell through to the
  // default branch. Validate against the closed set and fall back to
  // inference when the caller sends something unrecognised.
  const explicit = metadata?.memoryType;
  if (isMemoryType(explicit)) return explicit;
  const hay = `${namespace ?? ""} ${content}`.toLowerCase();
  if (/\b(prefer|prefers|likes|wants|communication style|response style)\b/.test(hay)) return "user_preference";
  if (/\b(root cause|post-?mortem|failed because|bug|incident|regression)\b/.test(hay)) return "bug_root_cause";
  if (/\b(decision|decided|chose|choose|selected|approved)\b/.test(hay)) return "decision";
  if (/\b(deploy|deployment|rollout|image|container|k3s|docker|ghcr|endpoint|runs on|host|port)\b/.test(hay)) return "deployment_state";
  if (/\b(setup|current setup|configured|configuration|model|server|service|endpoint|runs on|host|port|version)\b/.test(hay)) return "setup_fact";
  if (/\b(convention|standard|pattern|workflow|project uses|codebase uses)\b/.test(hay)) return "project_convention";
  if (/\b(safety|security|privacy|never|do not|don't|must not|credential|secret)\b/.test(hay)) return "safety_constraint";
  return "general";
}

/** Generic "this is about the person or their work" cues. Deliberately
 *  free of proper nouns: the previous version hard-coded this repo
 *  author's name and household terms, which meant every *other* operator
 *  of this self-hostable product scored their own name and projects at
 *  the lower 0.65 band. Deployment-specific vocabulary belongs in
 *  `personalTerms`, supplied by the caller. */
const RELEVANCE_CUES =
  /\b(i|me|my|mine|we|our|us|user|users|team|wife|husband|partner|spouse|family|household|kids?|children|project|projects|repo|repository|codebase|deployment|deploy|server|service|workflow|preference|prefers?)\b/i;

export function scoreWorthiness(
  content: string,
  type: MemoryType,
  confidence = 1,
  /** Optional deployment-specific high-relevance terms (the operator's
   *  own name, product names, project slugs). Matched case-insensitively
   *  as whole words. */
  personalTerms: readonly string[] = [],
): Record<string, number> {
  const len = content.trim().length;
  const durable = clamp01(len >= 80 ? 0.9 : len >= 40 ? 0.75 : 0.55);
  const reuseLikelihood = clamp01(["user_preference", "setup_fact", "deployment_state", "project_convention", "safety_constraint"].includes(type) ? 0.85 : type === "decision" ? 0.75 : type === "bug_root_cause" ? 0.7 : 0.45);
  const matchesPersonal =
    personalTerms.length > 0 &&
    personalTerms.some((term) => {
      const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return escaped.length > 0 && new RegExp(`\\b${escaped}\\b`, "i").test(content);
    });
  const userRelevance = clamp01(matchesPersonal || RELEVANCE_CUES.test(content) ? 0.9 : 0.65);
  const c = clamp01(confidence);
  const overall = clamp01(durable * 0.3 + reuseLikelihood * 0.3 + userRelevance * 0.25 + c * 0.15);
  return { durable, reuseLikelihood, userRelevance, confidence: c, overall };
}

export function retentionPolicyFor(type: MemoryType): Record<string, unknown> {
  switch (type) {
    case "user_preference": return { policy: "long_lived", baseEffectiveDays: 365, supersedeAggressively: false };
    case "safety_constraint": return { policy: "long_lived", baseEffectiveDays: 365, supersedeAggressively: false };
    case "setup_fact": return { policy: "supersede_aggressively", baseEffectiveDays: 60, supersedeAggressively: true };
    case "deployment_state": return { policy: "current_only", baseEffectiveDays: 30, supersedeAggressively: true };
    case "decision": return { policy: "medium_long", baseEffectiveDays: 180, supersedeAggressively: false };
    case "bug_root_cause": return { policy: "medium", baseEffectiveDays: 120, supersedeAggressively: false };
    case "project_convention": return { policy: "long_lived", baseEffectiveDays: 240, supersedeAggressively: true };
    default: return { policy: "standard", baseEffectiveDays: 90, supersedeAggressively: false };
  }
}

function captureMetadata(
  req: RememberRequest,
  action: string,
  extra: Record<string, unknown> = {},
  personalTerms: readonly string[] = [],
): Record<string, unknown> {
  const type = inferMemoryType(req.content, req.namespace, req.metadata);
  const sensitivity = inferSensitivity(req.content, req.metadata, req.sensitivity);
  return mergeCaptureMetadata(undefined, req.metadata, {
    memoryType: type,
    sensitivity,
    worthiness: scoreWorthiness(req.content, type, req.confidence ?? 1, personalTerms),
    retention: retentionPolicyFor(type),
    captureAction: action,
    ...extra,
  });
}

/** Minimal logger surface — structurally compatible with Pino /
 *  Fastify's logger. Object-first: `(obj, msg)` is the idiomatic Pino
 *  call shape; the bare-string overload is kept for the small handful
 *  of callers that don't have structured fields to attach.
 *  Defaults to console when none is supplied. */
export interface EngineLogger {
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  info?(obj: object, msg?: string): void;
  info?(msg: string): void;
}

export interface EngineConfig {
  warm: WarmStore;
  cold: ColdStore;
  graph: GraphStore | null;
  embedder: Embedder;
  /** Default decay schedule (in days). Used as the base when `effectiveDays`
   *  isn't overridden per call. */
  defaultEffectiveDays?: number;
  /** Optional logger. Defaults to console. */
  logger?: EngineLogger;
  /** When remembering a new entry, link it to this many top vector neighbours
   *  in the graph (skip self). Set to 0 to disable auto-edges. Default 3. */
  graphLinkFanout?: number;
  /** Optional metrics collector. When set, the engine instruments its
   *  hot paths (search/remember/forget/promote/demote/decay/reap). Pure
   *  observation — never affects behaviour. */
  metrics?: MetricsCollector;
  /** Arch-plan Phase 2: optional write-time LLM fact extractor. When
   *  provided, every `remember()` schedules a background pass that
   *  distills the chunk into typed facts and stores each as a sibling
   *  memory_entries row. Fire-and-forget — never blocks the write. */
  extractor?: import("./fact-extractor.js").FactExtractor;
  /** Max facts to store per chunk (extractor self-limits at LLM time; this
   *  is a belt-and-braces ingest cap). */
  extractorMaxFacts?: number;
  /** Arch-plan Phase 4: optional query decomposer for /v1/search. When
   *  provided AND the caller opts in via SearchRequest.decompose=true,
   *  the query is rewritten into ≤N parallel sub-queries before retrieval. */
  decomposer?: import("./query-decomposer.js").QueryDecomposer;
  /** Arch-plan Phase 5: optional observer/reflector for /v1/context-prefix. */
  observer?: import("./observer.js").Observer;
  /** Deployment-specific high-relevance vocabulary (operator name,
   *  product names, project slugs) used by the worthiness scorer. */
  personalTerms?: readonly string[];
  /** Absolute cosine floor for vector-only search candidates. See
   *  `DEFAULT_MIN_VECTOR_SCORE`. */
  minVectorScore?: number;
  /** Maximum content length (characters) accepted by remember/capture.
   *  Content beyond the embedding model's context window is silently
   *  truncated by the tokenizer, so the tail of a long memory becomes
   *  invisible to vector search while still being findable by keyword —
   *  a confusing half-stored state. Rejecting is the honest option and
   *  matches the "one fact per entry" guidance the skill already gives.
   *  Set 0 to disable the check. */
  maxContentChars?: number;
}

export class MemoryEngine {
  private readonly warm: WarmStore;
  private readonly cold: ColdStore;
  private readonly graph: GraphStore | null;
  private readonly embedder: Embedder;
  private readonly defaultDecayDays: number;
  private logger: EngineLogger;
  private readonly graphLinkFanout: number;
  private readonly metrics: MetricsCollector | null;
  private readonly extractor: import("./fact-extractor.js").FactExtractor | null;
  private readonly extractorMaxFacts: number;
  private readonly decomposer: import("./query-decomposer.js").QueryDecomposer | null;
  private readonly observer: import("./observer.js").Observer | null;
  private readonly personalTerms: readonly string[];
  private readonly minVectorScore: number;
  private readonly maxContentChars: number;
  /** Reactive promotions since the last decay run — flushed to
   *  `decay_runs.promoted` so the column stops being dead weight. */
  private promotedSinceLastDecay = 0;
  private readonly startedAt = Date.now();
  /** Resume point for the dream cycle's table walk (a ULID entry id, or
   *  "" to start from the beginning). Persisted in `engine_state` so a
   *  restart resumes where the last run stopped — an in-memory cursor
   *  rewound to the beginning on every deploy, which on a store larger
   *  than one batch meant the oldest rows were re-compacted forever and
   *  the newer ones never reached. Cached here to keep the hot path free
   *  of a read per cycle. */
  private dreamCursor: string | null = null;

  constructor(cfg: EngineConfig) {
    this.warm = cfg.warm;
    this.cold = cfg.cold;
    this.graph = cfg.graph;
    this.embedder = cfg.embedder;
    this.defaultDecayDays = cfg.defaultEffectiveDays ?? 7;
    // Default-to-console fallback. The cast is safe: console.warn /
    // .error / .info are structurally compatible with the
    // (obj|string, msg?) overloads — the second positional arg is just
    // appended as an extra arg by console, which is fine for fallback.
    this.logger = cfg.logger ?? (console as unknown as EngineLogger);
    this.graphLinkFanout = cfg.graphLinkFanout ?? 3;
    this.metrics = cfg.metrics ?? null;
    this.extractor = cfg.extractor ?? null;
    this.extractorMaxFacts = cfg.extractorMaxFacts ?? 5;
    this.decomposer = cfg.decomposer ?? null;
    this.observer = cfg.observer ?? null;
    this.personalTerms = cfg.personalTerms ?? [];
    this.minVectorScore = cfg.minVectorScore ?? DEFAULT_MIN_VECTOR_SCORE;
    this.maxContentChars = cfg.maxContentChars ?? 4_000;
  }

  /** Detect a change of embedding model between runs.
   *
   *  Vectors from two different models live in incompatible spaces, so a
   *  swap silently invalidates every stored embedding: cosine scores
   *  become meaningless, old memories stop being findable, and the
   *  capture dedup threshold misfires. When the dimension also changes
   *  the cold store at least errors on upsert — but a same-dimension swap
   *  (384 → 384 is the common case) fails completely silently, which is
   *  the worst version.
   *
   *  We can't re-embed the corpus safely on boot without knowing the
   *  operator's intent, so this records the model id and warns loudly on
   *  a mismatch, telling them exactly what to do. Called from main.ts
   *  after the stores are up. */
  async checkEmbeddingModel(): Promise<{ changed: boolean; previous: string | null }> {
    const current = this.embedder.modelId;
    let previous: string | null = null;
    try {
      previous = await this.warm.getEngineState(EMBEDDING_MODEL_KEY);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        "could not read stored embedding-model id — skipping mismatch check",
      );
      return { changed: false, previous: null };
    }
    if (previous && previous !== current) {
      this.logger.error(
        { previousModel: previous, currentModel: current },
        "EMBEDDING MODEL CHANGED — stored vectors were produced by a different model and are " +
          "no longer comparable to new ones. Vector search will silently return poor or empty " +
          "results for existing memories until they are re-embedded. Either restore the previous " +
          "model, or re-embed the corpus (content is all in Postgres, so re-embedding is total " +
          "and safe).",
      );
      await this.warm.setEngineState(EMBEDDING_MODEL_KEY, current).catch(() => {});
      return { changed: true, previous };
    }
    if (!previous) {
      await this.warm.setEngineState(EMBEDDING_MODEL_KEY, current).catch(() => {});
    }
    return { changed: false, previous };
  }

  /** Replace the engine's logger after construction. main.ts uses this
   *  to swap the boot-time console fallback for `app.log.child({ component: "engine" })`
   *  once the Fastify server (and thus the Pino logger) exists. */
  setLogger(logger: EngineLogger): void {
    this.logger = logger;
  }

  /** Reactive promotion: a cold entry earns warm status when its accumulated
   *  lifespan (`7 × log₂(hits+1)`) exceeds how long it had been idle before
   *  this hit. Without that check, *any* incidental match would re-promote,
   *  defeating the decay maths. Stats are read pre-bump so a fresh hit
   *  doesn't reset the clock against itself. */
  private async maybePromote(id: string, preBump: { hits: number; idleDays: number } | null): Promise<boolean> {
    if (!preBump) return false;
    // After this call returns the engine bumps hits → +1; lifespan uses the
    // post-bump count so the entry's growth is reflected immediately.
    const lifespan = effectiveDays(preBump.hits + 1);
    if (lifespan <= preBump.idleDays) return false;
    await this.warm.markCold(id, false);
    this.promotedSinceLastDecay++;
    this.metrics?.recordPromotion();
    return true;
  }

  /** Resolve the implicit namespace fanout for search/recent when the
   *  caller specified neither `namespace` nor `includeNamespaces`. Walks
   *  every scope (user-global + each active project) and unions the
   *  distinct namespaces with entries *visible* in that scope — note
   *  that in project scope a member sees other members' namespaces too
   *  (project is the isolation boundary). Falls back to `["default"]`
   *  when nothing is visible yet — the embedder / FTS still need a
   *  target name. Deduplicated; order is not stable. */
  private async resolveDefaultNamespaces(
    userId: string,
    scopes: Array<string | null>,
  ): Promise<string[]> {
    // includeProjects mode (multi-scope) and single-scope (one entry,
    // possibly null for user-global) collapse to the same fanout per
    // listNamespaces call.
    const found = new Set<string>();
    if (scopes.length > 1) {
      // Active-project mode: pass the project-id list through.
      const includeProjects = scopes.filter((s): s is string => s !== null);
      const ns = await this.warm.listNamespaces(userId, { includeProjects });
      for (const n of ns) found.add(n);
    } else {
      const single = scopes[0] ?? null;
      const ns = await this.warm.listNamespaces(userId, { projectId: single });
      for (const n of ns) found.add(n);
    }
    if (found.size === 0) return ["default"];
    return [...found];
  }

  private lastGraphWarn = 0;
  private maybeWarnGraphDown(): void {
    const now = Date.now();
    if (now - this.lastGraphWarn < 5 * 60 * 1000) return;
    this.lastGraphWarn = now;
    this.logger.warn("graph store unreachable — search degraded to keyword + vector only");
  }

  /** Last observed embedder outcomes. A destroyed embeddings host is
   *  invisible in every other signal — the writes still succeed and the
   *  searches still return rows — so the engine has to remember that it
   *  failed in order to report it at all. */
  private lastEmbedErrorAt: number | null = null;
  private lastEmbedOkAt: number | null = null;
  /** Backlog as of the last reconciler tick. Cached rather than counted
   *  on demand because health() is on the k8s probe path and must not
   *  add a query per probe. */
  private pendingEmbeddingsSeen: number | null = null;
  private lastEmbedErrorLoggedAt = 0;
  private suppressedEmbedErrors = 0;

  /** Log an embedder failure at ERROR — this is data becoming unfindable,
   *  not a degraded nicety — but at most once a minute. A dead embeddings
   *  host fails on *every* write, and an unthrottled ERROR per write turns
   *  a two-day outage into a log volume incident on top of a search
   *  incident. The suppressed count rides along so nothing is hidden. */
  private recordEmbedFailure(err: unknown, context: Record<string, unknown>): void {
    this.lastEmbedErrorAt = Date.now();
    const now = Date.now();
    if (now - this.lastEmbedErrorLoggedAt < 60_000) {
      this.suppressedEmbedErrors++;
      return;
    }
    const suppressed = this.suppressedEmbedErrors;
    this.lastEmbedErrorLoggedAt = now;
    this.suppressedEmbedErrors = 0;
    this.logger.error(
      { ...context, err: (err as Error).message, suppressedSinceLastLog: suppressed },
      "embedder failed — entry stored without a vector and is not findable by semantic search until the reconciler drains it",
    );
  }

  private recordEmbedSuccess(): void {
    this.lastEmbedOkAt = Date.now();
  }

  /** Hard-rule worthiness gate. Returns null when the content is fit to
   *  store, or a short reason string when it should be rejected. The
   *  caller is responsible for honouring `force: true` to bypass.
   *
   *  Two rules:
   *    - too short to be durable knowledge (< 12 chars after trim)
   *    - obvious conversational filler (single-word / canned reply)
   *
   *  Exact-duplicate detection happens separately via content_hash so we
   *  can return the existing id instead of rejecting outright. */
  shouldReject(content: string): string | null {
    const trimmed = content.trim();
    if (trimmed.length < 12) return "too short — not durable knowledge";
    if (
      /^(thanks?|ok(ay)?|sure|got it|great|cool|yes|no|nope|yep|alright|noted|done)\.?$/i.test(
        trimmed,
      )
    ) {
      return "conversational filler — not durable knowledge";
    }
    // Embedding models silently truncate at their context window (~256
    // word-pieces for the default MiniLM), so everything past the cut is
    // invisible to vector search while keyword search still finds it.
    // Reject rather than half-store, and say what to do about it.
    if (this.maxContentChars > 0 && trimmed.length > this.maxContentChars) {
      return `too long (${trimmed.length} chars, max ${this.maxContentChars}) — split into one fact per entry`;
    }
    return null;
  }

  async remember(
    userId: string,
    req: RememberRequest,
    token?: TokenIdentity,
    /** Pre-computed embedding for `req.content`. `capture()` already
     *  embeds the content to find near-duplicates; passing it through
     *  halves the embedder calls on the agent-facing write path. */
    precomputedEmbedding?: number[],
  ): Promise<{ id: string | null; rejected?: string; deduplicated?: boolean; embedded?: boolean }> {
    return traceAsync("MemoryEngine.remember", {
      "novamem.namespace": req.namespace ?? "default",
      "novamem.project": req.project ?? "",
      "novamem.content_chars": req.content.length,
      "novamem.force": Boolean(req.force),
    }, async (span) => {
      const rememberStartedAt = Date.now();
      // ── Worthiness gate (hard rules + dedup) ────────────────────────
      if (!req.force) {
        const reason = this.shouldReject(req.content);
        if (reason) {
          span.setAttribute("novamem.rejected", reason);
          return { id: null, rejected: reason };
        }
      }
      req = withSensitivityMetadata(req);
      const namespace = req.namespace ?? "default";
      const projectId = req.project ?? null;
      const contentHash = sha256Hex(req.content.trim());
      // Exact-duplicate fast-path: same user, same project, same hash → return
      // the existing id and bump hits instead of inserting a second row.
      const existing = await traceAsync("WarmStore.findByContentHash", { "novamem.namespace": namespace }, () =>
        this.warm.findByContentHash(userId, projectId, contentHash),
      );
      if (existing) {
        span.setAttribute("novamem.deduplicated", true);
        await traceAsync("WarmStore.bumpHits", { "novamem.entry_id": existing.id }, () => this.warm.bumpHits(existing.id));
        // Self-heal the insert-side partial write. If a previous attempt
        // stored the warm row and then died before the cold upsert (embed
        // failure, Qdrant blip), the entry has no vector and is invisible
        // to vector search *forever* — this dedup fast-path used to
        // return the id and bump hits without ever noticing. The delete
        // side has had a repair queue (`cold_orphans` + reaper) all
        // along; this is its missing twin.
        //
        // Repair the entry where it actually lives. Dedup matches on
        // (user, project, hash) with namespace excluded, so `existing`
        // may sit on a different shelf than this request targets. Passing
        // the *request's* namespace made this "repair" index the entry
        // under a namespace it was never written to, and search scoped to
        // that namespace then returned it — a cross-shelf leak.
        await this.backfillMissingVector(userId, projectId, existing.id, existing.namespace, req);
        this.metrics?.recordRemember(userId, token);
        // The dedup target may itself be an outage-window row with no
        // vector. Report its real state rather than inheriting this
        // call's optimism.
        return { id: existing.id, deduplicated: true, embedded: await this.warm.isEmbedded(existing.id) };
      }
      const id = await traceAsync("WarmStore.insertEntry", { "novamem.namespace": namespace }, () =>
        this.warm.insertEntry({
          userId,
          projectId,
          content: req.content,
          namespace,
          source: req.source ?? "manual",
          agentName: req.agentName ?? null,
          metadata: req.sensitivity ? { ...(req.metadata ?? {}), sensitivity: req.sensitivity } : req.metadata,
          sourceType: req.sourceType ?? null,
          capturedFrom: req.capturedFrom ?? null,
          confidence: req.confidence,
          contentHash,
        }),
      );
      span.setAttribute("novamem.entry_id", id);
      // The row is already committed. If the embedder is unreachable we
      // keep it that way and leave `embedded_at` NULL: losing the memory
      // outright is a worse failure than a memory that is temporarily
      // findable by keyword and graph only, and the NULL is what lets the
      // reconciler finish the job later.
      let embedding: number[] | undefined;
      let embedderDown = false;
      if (precomputedEmbedding) {
        embedding = precomputedEmbedding;
      } else {
        try {
          [embedding] = await traceAsync("Embedder.embed.remember", {
            "novamem.content_chars": req.content.length,
          }, () => this.embedder.embed(req.content, "document"));
          this.recordEmbedSuccess();
        } catch (err) {
          embedderDown = true;
          this.recordEmbedFailure(err, { entryId: id, op: "remember" });
        }
      }
      span.setAttribute("novamem.embedding_present", Boolean(embedding));
      let embedded = false;
      if (embedding) {
        // If the vector write fails the warm row is already committed.
        // Park it so the reaper can finish the job instead of leaving a
        // memory that keyword search can find and vector search cannot.
        try {
          await traceAsync("ColdStore.upsert", { "novamem.namespace": namespace, "novamem.embedding_dim": embedding.length }, () =>
            this.cold.upsert({
              userId,
              projectId,
              id,
              namespace,
              embedding,
              payload: {
                source: req.source ?? "manual",
                agentName: req.agentName ?? null,
                embeddingModel: this.embedder.modelId,
              },
            }),
          );
        } catch (err) {
          await this.parkMissingVector(userId, projectId, id, namespace, err);
          throw err;
        }
        // Stamp only after the vector is durably in the cold store. The
        // marker means "a vector exists", so ordering it after the upsert
        // is what keeps it from lying when the cold store is the tier
        // that failed.
        await this.warm.setEmbeddedAt(id, new Date());
        embedded = true;
        if (this.graphLinkFanout > 0) {
          await traceAsync("MemoryEngine.linkVectorNeighbors", {
            "novamem.namespace": namespace,
            "novamem.graph_link_fanout": this.graphLinkFanout,
          }, () => this.linkVectorNeighbors(userId, projectId, id, namespace, embedding, req.content));
        }
      } else if (!embedderDown) {
        // The embedder answered but handed back nothing — a bad response,
        // not an outage, so the reaper's repair queue is the right owner.
        // A genuine outage is deliberately NOT parked here: during a
        // multi-day embedder failure every write would enqueue an orphan,
        // and the reaper would burn its bounded attempt budget against a
        // dead host and then *abandon* the entries. The NULL `embedded_at`
        // left on the row is the outage queue, and the reconciler drains
        // it with no attempt ceiling once the embedder returns.
        await this.parkMissingVector(userId, projectId, id, namespace, new Error("embedder returned no vector"));
      }
      span.setAttribute("novamem.embedded", embedded);
      this.metrics?.recordRemember(userId, token);
      // Arch-plan Phase 2: schedule LLM fact extraction in the background.
      // Fire-and-forget — never blocks the write. Errors are logged only.
      if (this.extractor) {
        // Capture necessary closure values before the floating promise.
        const chunkId = id;
        const chunkContent = req.content;
        const chunkNamespace = namespace;
        const chunkProjectId = projectId;
        const sensitivity = req.sensitivity;
        const sourceMeta = req.source ?? "manual";
        void this.storeFactsForChunk({
          userId,
          projectId: chunkProjectId,
          chunkId,
          chunkContent,
          namespace: chunkNamespace,
          sensitivity,
          parentSource: sourceMeta,
        }).catch((err: unknown) => {
          this.logger.warn(
            { err: (err as Error).message, chunkId },
            "fact extraction failed (chunk persisted, no facts)",
          );
        });
      }
      this.metrics?.recordLatency("remember", Date.now() - rememberStartedAt);
      return { id, embedded };
    }).catch((err) => {
      this.metrics?.recordError("remember");
      throw err;
    });
  }

  /** Arch-plan Phase 2 helper: distill a raw chunk into typed facts and
   *  store each as its own memory_entries row + Qdrant point.
   *  Each fact's metadata carries the fact object and a `source_chunk_id`
   *  pointer back to the raw chunk so the answerer can join up to original
   *  text on demand. ADD-only — contradictions are resolved at read time
   *  via recency / temporal scoring (Mem0 v2 pattern). */
  private async storeFactsForChunk(args: {
    userId: string;
    projectId: string | null;
    chunkId: string;
    chunkContent: string;
    namespace: string;
    sensitivity?: SensitivityLevel;
    parentSource: string;
  }): Promise<void> {
    if (!this.extractor) return;
    const facts = await traceAsync(
      "FactExtractor.extract",
      { "novamem.chunk_id": args.chunkId, "novamem.content_chars": args.chunkContent.length },
      () => this.extractor!.extract(args.chunkContent),
    );
    if (facts.length === 0) return;
    const { factToText } = await import("./fact-extractor.js");
    const capped = facts.slice(0, this.extractorMaxFacts);
    for (const fact of capped) {
      const text = factToText(fact);
      // Each fact gets its own content-hash so dedup behaves correctly
      // (an identical fact ingested from a different chunk won't double-store).
      const contentHash = sha256Hex(text.trim());
      const existing = await this.warm.findByContentHash(args.userId, args.projectId, contentHash);
      if (existing) {
        await this.warm.bumpHits(existing.id);
        continue;
      }
      // ── Mem0-style updation (arch-plan gap #2) ───────────────────────
      // Embed first so we can search for semantically-similar existing
      // facts and let the LLM decide ADD / UPDATE / DELETE / NOOP. This
      // is what closes Mem0 v1 (~67% LongMemEval) → v2 (93%): write-time
      // dedup + supersedence vs uncurated ADD-only. We pay one extra
      // LLM call per new fact when the similarity gate fires; the
      // semaphore in FactExtractor keeps upstream queue depth bounded.
      let factEmbedding: number[] | null = null;
      try {
        const embedded = await this.embedder.embed(text);
        factEmbedding = embedded[0] ?? null;
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, chunkId: args.chunkId },
          "embedding fact failed (will store as ADD without similarity check)",
        );
      }
      let similar: Array<{ id: string; text: string; factType?: string; importance?: number }> = [];
      if (factEmbedding) {
        try {
          const hits = await this.cold.search({
            userId: args.userId,
            projectId: args.projectId,
            namespace: args.namespace,
            embedding: factEmbedding,
            k: 5,
          });
          if (hits.length > 0) {
            const ids = hits.map((h) => h.id);
            const rows = await this.warm.getEntries(args.userId, ids, {
              projectId: args.projectId,
            });
            similar = rows
              .map((r, i) => {
                if (!r) return null;
                // Only compare against existing FACT rows. Comparing the
                // new fact to a raw chunk would prompt UPDATE/DELETE on
                // the chunk which is wrong — chunks aren't supersedable.
                if (r.sourceType !== "fact") return null;
                const meta = (r.metadata ?? {}) as Record<string, unknown>;
                const f = (meta.fact ?? {}) as Record<string, unknown>;
                return {
                  id: ids[i]!,
                  text: r.content,
                  factType: typeof f.type === "string" ? f.type : undefined,
                  importance: typeof f.importance === "number" ? f.importance : undefined,
                };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null);
          }
        } catch (err) {
          this.logger.warn(
            { err: (err as Error).message, chunkId: args.chunkId },
            "similarity search for updation failed (defaulting to ADD)",
          );
        }
      }
      const decision = similar.length > 0
        ? await traceAsync(
            "FactExtractor.decideOperation",
            { "novamem.candidate_count": similar.length },
            () => this.extractor!.decideOperation(text, similar),
          )
        : { op: "ADD" as const, targetId: undefined as string | undefined };

      if (decision.op === "NOOP" && decision.targetId) {
        await this.warm.bumpHits(decision.targetId);
        continue;
      }
      if (decision.op === "UPDATE" && decision.targetId) {
        // Replace the existing fact's content + metadata in place; bump
        // hits. Embedding stays the new text's via cold.upsert(targetId).
        const ok = await this.warm.updateEntry({
          userId: args.userId,
          id: decision.targetId,
          projectId: args.projectId,
          content: text,
          metadata: {
            fact: {
              type: fact.type,
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              occurred_at: fact.occurredAt ?? null,
              entities: fact.entities,
              importance: fact.importance,
            },
            source_chunk_id: args.chunkId,
            updated_via: "fact_updation",
            ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
          } as Record<string, unknown>,
          contentHash,
        });
        if (ok && factEmbedding) {
          try {
            await this.cold.upsert({
              userId: args.userId,
              projectId: args.projectId,
              id: decision.targetId,
              namespace: args.namespace,
              embedding: factEmbedding,
              payload: { source: args.parentSource, agentName: null },
            });
          } catch (err) {
            this.logger.warn(
              { err: (err as Error).message, factId: decision.targetId },
              "cold.upsert on UPDATE failed (warm row updated, vector stale)",
            );
          }
          await this.warm.bumpHits(decision.targetId);
        }
        continue;
      }
      if (decision.op === "DELETE" && decision.targetId) {
        // Mark the contradicted fact inactive via metadata so it falls
        // out of `isInactiveMemory` filtering at search time, but don't
        // hard-delete (history-preserving — Mem0/Zep pattern). Then
        // store the new fact as ADD.
        try {
          await this.warm.updateEntry({
            userId: args.userId,
            id: decision.targetId,
            projectId: args.projectId,
            metadata: {
              fact_inactive: true,
              superseded_at: new Date().toISOString(),
              superseded_by_chunk: args.chunkId,
            } as Record<string, unknown>,
          });
        } catch (err) {
          this.logger.warn(
            { err: (err as Error).message, targetId: decision.targetId },
            "DELETE supersede update failed (continuing to ADD)",
          );
        }
        // Fall through to ADD below.
      }

      // ADD (default + post-DELETE)
      const factId = await this.warm.insertEntry({
        userId: args.userId,
        projectId: args.projectId,
        content: text,
        namespace: args.namespace,
        source: args.parentSource,
        agentName: null,
        metadata: {
          fact: {
            type: fact.type,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            occurred_at: fact.occurredAt ?? null,
            entities: fact.entities,
            importance: fact.importance,
          },
          source_chunk_id: args.chunkId,
          ...(decision.op === "ADD" && decision.targetId
            ? { supersedes: decision.targetId }
            : {}),
          ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
        } as Record<string, unknown>,
        sourceType: "fact",
        capturedFrom: null,
        confidence: 1,
        contentHash,
      });
      if (factEmbedding) {
        try {
          await this.cold.upsert({
            userId: args.userId,
            projectId: args.projectId,
            id: factId,
            namespace: args.namespace,
            embedding: factEmbedding,
            payload: { source: args.parentSource, agentName: null },
          });
        } catch (err) {
          this.logger.warn(
            { err: (err as Error).message, factId, chunkId: args.chunkId },
            "cold.upsert on ADD failed (fact persisted in warm only)",
          );
        }
      }
    }
  }

  /** Record a warm row whose cold vector is missing, so `reapOrphans()`
   *  can re-embed and upsert it later. Best-effort: if even this write
   *  fails we log — the hygiene report still detects the state via
   *  `warm_without_cold_vector`. */
  private async parkMissingVector(
    userId: string,
    projectId: string | null,
    id: string,
    namespace: string,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.warm.recordMissingVector({ userId, projectId, entryId: id, namespace });
      this.logger.warn(
        { entryId: id, namespace, err: (cause as Error)?.message },
        "cold upsert failed — parked for vector backfill",
      );
    } catch (err) {
      this.logger.error(
        { entryId: id, namespace, err: (err as Error).message },
        "cold upsert failed AND could not park entry for backfill",
      );
    }
  }

  /** Repair path for the dedup fast-path: verify the existing entry still
   *  has a vector, and re-embed if not. Failures are logged, never
   *  fatal — a dedup hit must stay a success. */
  private async backfillMissingVector(
    userId: string,
    projectId: string | null,
    id: string,
    namespace: string,
    req: RememberRequest,
  ): Promise<void> {
    try {
      const present = await this.cold.existingIds([{ id, userId, projectId, namespace }]);
      if (present.has(id)) return;
      const [embedding] = await this.embedder.embed(req.content, "document");
      if (!embedding) return;
      await this.cold.upsert({
        userId,
        projectId,
        id,
        namespace,
        embedding,
        payload: {
          source: req.source ?? "manual",
          agentName: req.agentName ?? null,
          embeddingModel: this.embedder.modelId,
        },
      });
      await this.warm.clearMissingVector(id);
      this.logger.info?.({ entryId: id, namespace }, "backfilled missing cold vector on dedup hit");
    } catch (err) {
      this.logger.warn(
        { entryId: id, namespace, err: (err as Error).message },
        "vector backfill on dedup hit failed",
      );
    }
  }

  /** Capture is the agent-facing write path. Unlike raw remember(), it first
   *  looks for semantically-close active memories in the same scope. A near
   *  duplicate is updated in-place; a close contradiction is stored as the
   *  new active fact while the older fact is marked superseded. */
  async capture(
    userId: string,
    req: RememberRequest,
    token?: TokenIdentity,
  ): Promise<{
    id: string | null;
    rejected?: string;
    deduplicated?: boolean;
    updated?: boolean;
    superseded?: string[];
    /** False when the entry is stored but has no vector yet. Callers need
     *  this to tell "stored and searchable" from "stored but not yet
     *  findable semantically" — a 201 alone cannot say which. */
    embedded?: boolean;
  }> {
    // capture() is the primary agent-facing write, but only the nested
    // remember() call was ever traced — the dedup search, the
    // contradiction check and the supersede path were invisible in a
    // trace. Span it directly.
    return traceAsync("MemoryEngine.capture", {
      "novamem.namespace": req.namespace ?? "default",
      "novamem.project": req.project ?? "",
      "novamem.content_chars": req.content.length,
    }, async (span) => {
      const r = await this.captureInner(userId, req, token);
      span.setAttribute("novamem.capture_updated", Boolean(r.updated));
      span.setAttribute("novamem.capture_superseded", r.superseded?.length ?? 0);
      span.setAttribute("novamem.deduplicated", Boolean(r.deduplicated));
      if (r.rejected) span.setAttribute("novamem.rejected", r.rejected);
      return r;
    });
  }

  private async captureInner(
    userId: string,
    req: RememberRequest,
    token?: TokenIdentity,
  ): Promise<{
    id: string | null;
    rejected?: string;
    deduplicated?: boolean;
    updated?: boolean;
    superseded?: string[];
    embedded?: boolean;
  }> {
    req = withSensitivityMetadata(req);
    if (!req.force) {
      const reason = this.shouldReject(req.content);
      if (reason) return { id: null, rejected: reason };
    }

    const namespace = req.namespace ?? "default";
    const projectId = req.project ?? null;
    const contentHash = sha256Hex(req.content.trim());
    const exact = await this.warm.findByContentHash(userId, projectId, contentHash);
    if (exact) {
      await this.warm.bumpHits(exact.id);
      // Same self-heal as remember()'s dedup fast-path: an entry whose
      // cold upsert failed on an earlier attempt would otherwise stay
      // invisible to vector search forever, because this short-circuit
      // never re-embeds. capture() is the agent-facing write path, so
      // it matters most here.
      //
      // Repaired in the entry's own namespace, not the request's — see
      // the matching note in remember(). Dedup spans namespaces, so these
      // can differ, and using the request's leaked entries across shelves.
      await this.backfillMissingVector(userId, projectId, exact.id, exact.namespace, req);
      this.metrics?.recordRemember(userId, token);
      return { id: exact.id, deduplicated: true, embedded: await this.warm.isEmbedded(exact.id) };
    }

    // This embed only powers the near-duplicate lookup, and unlike
    // remember() it runs *before* anything is written. An unguarded throw
    // here would drop the caller's memory on the floor for the duration
    // of an embedder outage — the one outcome worse than storing it
    // unembedded. On failure we skip dedup and fall through to the plain
    // insert; the cost is a possible duplicate row, which the dream
    // cycle merges later.
    let embedding: number[] | undefined;
    try {
      [embedding] = await this.embedder.embed(req.content, "document");
      this.recordEmbedSuccess();
    } catch (err) {
      this.recordEmbedFailure(err, { op: "capture.dedup-probe" });
    }
    if (embedding) {
      const nearby = await this.cold.search({
        userId,
        projectId,
        namespace,
        embedding,
        k: CAPTURE_CANDIDATE_K,
      });
      const candidateIds = nearby
        .filter((h) => h.score >= SEMANTIC_DUPLICATE_THRESHOLD)
        .map((h) => h.id);
      const candidates = candidateIds.length > 0
        ? await this.warm.getEntries(userId, candidateIds, { projectId })
        : [];
      const candidate = candidates.find((e) => e && !isInactiveMemory(e.metadata as Record<string, unknown> | null | undefined));
      if (candidate) {
        if (looksContradictory(candidate.content, req.content)) {
          return this.supersedeWithNewFact(userId, candidate, req, namespace, projectId, token, embedding);
        }

        // ── Overwrite guard ───────────────────────────────────────────
        // A high cosine alone does NOT mean "same fact restated". Two
        // distinct facts can clear the 0.92 semantic-duplicate threshold
        // while differing in the one word that matters: "wife's birthday
        // is May 3" vs "daughter's birthday is May 3" carry identical
        // scalars (so `looksContradictory` sees no conflict) and nearly
        // identical shape. Updating in place there silently destroyed
        // the first fact, with no supersession trail to recover it.
        //
        // `isContentSuperset` only permits the overwrite when the new
        // text keeps every content word the old one had — see its
        // doc-comment for why a similarity threshold (including the
        // dream cycle's Jaccard gate) cannot make this call.
        if (isContentSuperset(candidate.content, req.content)) {
          const inferredType = inferMemoryType(req.content, namespace, req.metadata);
          const mergedMetadata = mergeCaptureMetadata(candidate.metadata as Record<string, unknown> | null | undefined, req.metadata, {
            memoryType: inferredType,
            worthiness: scoreWorthiness(req.content, inferredType, req.confidence ?? 1, this.personalTerms),
            retention: retentionPolicyFor(inferredType),
            captureAction: "updated",
            updatedByCaptureAt: new Date().toISOString(),
          });
          const updated = await this.update(userId, candidate.id, {
            content: req.content,
            namespace,
            metadata: mergedMetadata,
            sourceType: req.sourceType ?? "chat",
            capturedFrom: req.capturedFrom ?? "memory_capture",
            confidence: req.confidence,
            project: projectId,
          });
          if (updated.updated) {
            this.metrics?.recordRemember(userId, token);
            // `embeddingChanged` is false when the re-embed failed, so the
            // caller is told the row is stored but not yet searchable.
            return {
              id: candidate.id,
              deduplicated: true,
              updated: true,
              embedded: updated.embeddingChanged,
            };
          }
        }
      }
    }

    return this.remember(userId, {
      ...req,
      namespace,
      metadata: captureMetadata({ ...req, namespace }, "inserted", {}, this.personalTerms),
    }, token, embedding);
  }

  /** Store `req` as the new active fact and mark `candidate` superseded.
   *
   *  These two writes are not atomic (they touch different rows through
   *  different code paths), so the failure mode is handled explicitly: if
   *  marking the old fact superseded fails, the just-created row is
   *  removed again. Without that compensation the caller got a 500 while
   *  the new row stayed committed, leaving *two* active contradictory
   *  facts in the store — and a retry could not fix it, because the
   *  content-hash dedup path would then short-circuit to the orphaned
   *  new row. */
  private async supersedeWithNewFact(
    userId: string,
    candidate: { id: string; content: string; metadata: unknown },
    req: RememberRequest,
    namespace: string,
    projectId: string | null,
    token: TokenIdentity | undefined,
    embedding: number[],
  ): Promise<{
    id: string | null;
    superseded?: string[];
    rejected?: string;
    deduplicated?: boolean;
    embedded?: boolean;
  }> {
    const supersededIds = [candidate.id];
    const supersededAt = new Date().toISOString();
    const newMetadata = captureMetadata(
      req,
      "superseded",
      { supersedes: supersededIds, supersededAt },
      this.personalTerms,
    );
    const created = await this.remember(
      userId,
      { ...req, namespace, metadata: newMetadata, force: true },
      token,
      embedding,
    );
    if (!created.id) return created;
    try {
      const updated = await this.update(userId, candidate.id, {
        project: projectId,
        metadata: {
          ...((candidate.metadata as Record<string, unknown> | null) ?? {}),
          lifecycleStatus: "superseded",
          supersededBy: created.id,
          supersededReason: "contradiction",
          supersededAt,
        },
      });
      if (!updated.updated) throw new Error(`could not mark ${candidate.id} superseded`);
    } catch (err) {
      // Compensate: undo the new fact so the store never holds two
      // active contradictory memories, then surface the failure.
      try {
        await this.forget(userId, created.id, { project: projectId });
      } catch (rollbackErr) {
        this.logger.error(
          { entryId: created.id, err: (rollbackErr as Error).message },
          "capture: supersede failed AND rollback of the new fact failed — " +
            "store now holds two active contradictory memories",
        );
      }
      throw err;
    }
    return { id: created.id, superseded: supersededIds, embedded: created.embedded ?? false };
  }

  /** Update an existing entry in place. Preserves `created_at`,
   *  `memory_access.hits`, and graph edges; rewrites content / FTS / cold
   *  vector / metadata / provenance. Returns `{ updated: false }` when
   *  the id doesn't exist or is out of the caller's scope.
   *
   *  When `content` is omitted, the embedder isn't called — only the
   *  metadata-side fields move. */
  async update(
    userId: string,
    id: string,
    req: {
      content?: string;
      namespace?: string;
      metadata?: Record<string, unknown>;
      sourceType?: string;
      capturedFrom?: string;
      confidence?: number;
      project?: string | null;
      sensitivity?: SensitivityLevel;
    },
  ): Promise<{ updated: boolean; embeddingChanged: boolean }> {
    const projectId = req.project ?? null;
    const updateMetadata = req.sensitivity
      ? { ...(req.metadata ?? {}), sensitivity: req.sensitivity }
      : req.metadata;
    const newHash = req.content ? sha256Hex(req.content.trim()) : undefined;
    const ok = await this.warm.updateEntry({
      userId,
      id,
      projectId,
      content: req.content,
      namespace: req.namespace,
      metadata: updateMetadata,
      sourceType: req.sourceType,
      capturedFrom: req.capturedFrom,
      confidence: req.confidence,
      contentHash: newHash,
    });
    if (!ok) return { updated: false, embeddingChanged: false };
    let embeddingChanged = false;
    if (req.content) {
      // Re-resolve the entry to learn its actual namespace (the caller
      // may have omitted it from the update body).
      const entry = await this.warm.getEntry(userId, id, { projectId });
      if (!entry) return { updated: true, embeddingChanged: false };
      let embedding: number[] | undefined;
      try {
        [embedding] = await this.embedder.embed(req.content);
        this.recordEmbedSuccess();
      } catch (err) {
        this.recordEmbedFailure(err, { entryId: id, op: "update" });
      }
      if (embedding) {
        await this.cold.upsert({
          userId,
          projectId: entry.projectId ?? null,
          id,
          namespace: entry.namespace,
          embedding,
          payload: { source: entry.source, agentName: entry.agentName ?? null },
        });
        await this.warm.setEmbeddedAt(id, new Date());
        embeddingChanged = true;
      } else {
        // The content moved but the vector didn't. Re-queue rather than
        // leave the entry marked embedded: the stale vector now describes
        // text that no longer exists, so semantic search would surface
        // this entry for the *old* wording and miss it for the new.
        await this.warm.setEmbeddedAt(id, null);
      }
    }
    return { updated: true, embeddingChanged };
  }

  /** Find the new entry's top semantic neighbours and persist edges in both
   *  the graph store (for traversal) and `memory_relations` (for audit /
   *  fallback if the graph is offline). Self-links are filtered. Errors are
   *  logged and swallowed — failures to enrich shouldn't fail the write. */
  private async linkVectorNeighbors(
    userId: string,
    projectId: string | null,
    id: string,
    namespace: string,
    embedding: number[],
    content: string,
  ): Promise<void> {
    try {
      const hits = await traceAsync("ColdStore.search.linkVectorNeighbors", {
        "novamem.namespace": namespace,
        "novamem.k": this.graphLinkFanout + 1,
      }, () => this.cold.search({
        userId,
        projectId,
        namespace,
        embedding,
        k: this.graphLinkFanout + 1,
      }));
      const neighbours = hits.filter((h) => h.id !== id).slice(0, this.graphLinkFanout);
      // One batched Cypher round-trip instead of fanout-many.
      if (neighbours.length > 0 && this.graph?.isConnected()) {
        try {
          await traceAsync("GraphStore.addEdgesBatch", {
            "novamem.neighbour_count": neighbours.length,
          }, () => this.graph!.addEdgesBatch(
            userId,
            id,
            neighbours.map((n) => ({ to: n.id, relation: "co_occurs", strength: n.score })),
            projectId,
          ));
        } catch (err) {
          this.logger.warn(
            { entryId: id, err: (err as Error).message },
            "graph addEdgesBatch failed",
          );
        }
      }
      // Entity edges. Independent of the vector neighbours above — this
      // is what gives the graph tier a signal embeddings don't already
      // have. Failures are non-fatal: enrichment must never fail a write.
      if (this.graph?.isConnected()) {
        const entities = extractEntities(content);
        if (entities.length > 0) {
          try {
            await traceAsync("GraphStore.linkEntities", {
              "novamem.entity_count": entities.length,
            }, () => this.graph!.linkEntities(userId, id, entities, projectId));
          } catch (err) {
            this.logger.warn(
              { entryId: id, err: (err as Error).message },
              "graph linkEntities failed",
            );
          }
        }
      }
      // Warm relations are per-row in SQL but issued in parallel so the
      // span name "addRelation.batch" actually corresponds to one
      // synchronous round of pool-concurrent INSERTs instead of N
      // sequential round-trips. Each call hits a different
      // (from,to,relation) row so the ON CONFLICT DO UPDATE upsert
      // semantics are independent — no need for a transaction.
      await traceAsync("WarmStore.addRelation.batch", {
        "novamem.neighbour_count": neighbours.length,
      }, () => Promise.all(
        neighbours.map((n) =>
          this.warm.addRelation(userId, id, n.id, "co_occurs", n.score, projectId),
        ),
      ));
    } catch (err) {
      this.logger.warn(
        { entryId: id, err: (err as Error).message },
        "linkVectorNeighbors failed",
      );
    }
  }

  async search(
    userId: string,
    req: SearchRequest,
    token?: TokenIdentity,
  ): Promise<{ results: SearchResult[]; degraded: boolean }> {
    return traceAsync("MemoryEngine.search", {
      "novamem.namespace": req.namespace ?? "",
      "novamem.include_namespaces": req.includeNamespaces?.length ?? 0,
      "novamem.include_projects": req.includeProjects?.length ?? 0,
      "novamem.k": req.k ?? 10,
      "novamem.query_chars": req.query.length,
    }, async (span) => {
    const searchStartedAt = Date.now();
    const k = req.k ?? 10;
    const weights = { ...DEFAULT_WEIGHTS, ...(req.weights ?? {}) };

    // Active-project mode: when `includeProjects` is set, fan out across
    // (user-global) ∪ (each project) and merge before fusion. Single-
    // scope queries (project, or no project) collapse to one fanout.
    const scopes: Array<string | null> = req.includeProjects?.length
      ? [null, ...req.includeProjects]
      : [req.project ?? null];

    // Cross-namespace mode: when `includeNamespaces` is set, fan out across
    // each namespace within each scope. Cold-store collections are keyed
    // per (scope × namespace) so this fans out as a 2D matrix. The single
    // singular `namespace` field is ignored in this mode.
    //
    // When *neither* `namespace` nor `includeNamespaces` is given, fan out
    // across every namespace the caller has entries in (this scope). The
    // old behaviour silently defaulted to "default" — which meant a user
    // who wrote everything to a custom namespace got `[]` from search-
    // without-namespace, which was strictly a bug. Falls back to
    // ["default"] for fresh callers with no entries yet so the embedder /
    // FTS path still has a sensible target.
    const namespaces: string[] = req.includeNamespaces?.length
      ? req.includeNamespaces
      : req.namespace
        ? [req.namespace]
        : await this.resolveDefaultNamespaces(userId, scopes);

    // Arch-plan Phase 4: query decomposition. If opted in via req.decompose
    // and a decomposer is configured, rewrite into ≤N sub-queries and run
    // retrieval per sub-query. The original query is always included first.
    // The downstream FTS/vector fan-out then uses each sub-query in turn
    // and we union the hits before fusion.
    let queries: string[] = [req.query];
    if (req.decompose && this.decomposer) {
      try {
        const decomposed = await traceAsync(
          "QueryDecomposer.decompose",
          { "novamem.query_chars": req.query.length },
          () => this.decomposer!.decompose(req.query),
        );
        if (decomposed.length > 0) queries = decomposed;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, "decompose failed (using original query)");
      }
    }

    // Embed every query (one batch). Different sub-queries → different
    // vector candidates, which is the whole point of decomposition.
    //
    // A dead embedder is a failed tier, not a failed request: the caller
    // still gets keyword + graph. It must however mark the search
    // degraded, or an outage looks exactly like "nothing matched" — the
    // confusion that let a half-blind store pass for a healthy one.
    //
    // "query" side of the asymmetric-retrieval prefix pair — see
    // embeddings.ts. Symmetric models (the default MiniLM) get an empty
    // prefix and behave exactly as before.
    let degraded = false;
    let queryEmbeddings: number[][] = [];
    try {
      queryEmbeddings = await traceAsync("Embedder.embed.search", {
        "novamem.query_chars": req.query.length,
        "novamem.subqueries": queries.length,
      }, () => this.embedder.embed(queries, "query"));
      this.recordEmbedSuccess();
    } catch (err) {
      degraded = true;
      this.recordEmbedFailure(err, { op: "search" });
    }
    const embedding = queryEmbeddings[0] ?? null;
    // FTS supports multi-namespace via `namespace = ANY(...)` in one query
    // per scope, so we fan out only across scopes (not namespaces).
    // Cold-store needs one search per (scope × namespace) collection.
    //
    // Per-tier `.catch`: a flaky tier should degrade gracefully — search
    // still returns whatever the surviving tiers produced, and `degraded`
    // becomes meaningful for warm/cold (not just graph). Without this,
    // one Postgres or Qdrant blip rejects the whole top-level Promise.all.
    // (`degraded` is declared above — the query-embed step is the first
    // tier that can set it.)
    // Phase 4: per-sub-query keyword retrieval. Per-query promises are
    // independent so they run concurrently across the whole (queries ×
    // scopes) matrix; the resulting flat list is what feeds fuse().
    const keywordsPromise = Promise.all(
      queries.flatMap((q) =>
        scopes.map((projectId) =>
          traceAsync("WarmStore.ftsSearch", {
            "novamem.namespace_count": namespaces.length,
            "novamem.k": k * 3,
          }, () => this.warm.ftsSearch({
            userId,
            projectId,
            query: q,
            namespace: namespaces[0]!, // ignored when namespaces array is set
            namespaces: namespaces.length > 1 ? namespaces : undefined,
            k: k * 3,
            agentName: req.agentName === undefined ? undefined : (req.agentName ?? null),
          })),
        ),
      ),
    ).catch((err) => {
      degraded = true;
      this.logger.warn({ err: (err as Error).message }, "keyword tier failed");
      return [] as Array<Array<{ id: string; score: number }>>;
    });
    // Phase 4: per-sub-query vector retrieval. Each sub-query has its own
    // embedding so different facets surface different candidates.
    const vectorsPromise =
      queryEmbeddings.length > 0 && queryEmbeddings[0]
        ? Promise.all(
            queryEmbeddings.flatMap((emb) =>
              scopes.flatMap((projectId) =>
                namespaces.map((namespace) =>
                  traceAsync("ColdStore.search", {
                    "novamem.namespace": namespace,
                    "novamem.k": k * 3,
                  }, () => this.cold.search({ userId, projectId, namespace, embedding: emb, k: k * 3 })),
                ),
              ),
            ),
          ).catch((err) => {
            degraded = true;
            this.logger.warn({ err: (err as Error).message }, "vector tier failed");
            return [] as Array<Array<{ id: string; score: number }>>;
          })
        : Promise.resolve([] as Array<Array<{ id: string; score: number }>>);
    const [keywordHitsAll, vectorHitsAll] = await Promise.all([keywordsPromise, vectorsPromise]);
    const keywordHits = keywordHitsAll.flat();
    const vectorHits = vectorHitsAll.flat();
    // Single-scope path keeps the original projectId for downstream lookups
    // (entries / neighbors). Multi-scope path uses null + per-id resolution.
    const projectId = scopes.length === 1 ? scopes[0]! : null;

    // Arch-plan Phase 3: parse optional asOf into milliseconds for the
    // graph traversal's bitemporal filter.
    const asOfMs = req.asOf ? Date.parse(req.asOf) : null;
    let graphHits: Array<{ id: string; score: number }> = [];
    // Entity bridging works from the query text alone, so unlike the
    // neighbour walk it does not require the vector tier to have returned
    // anything — it still contributes when the embedder is down.
    if (this.graph?.isConnected()) {
      try {
        // Seed from the top few vector hits rather than only the single
        // best one. With one seed, an off-topic top-1 dragged its whole
        // (wrong) neighbourhood into the results, and a correct-but-
        // second-place hit contributed no graph signal at all.
        const seeds = [...vectorHits]
          .sort((a, b) => b.score - a.score)
          .slice(0, GRAPH_SEED_COUNT)
          .map((h) => h.id);
        // Graph neighbours scope: when in active-project mode the seed is
        // ambiguous, so skip the project scope (project_id is null) — entry
        // resolution below will still filter to the visible scope set.
        const seedScope = scopes.length === 1 ? scopes[0]! : null;
        const asOfFilter = asOfMs !== null && Number.isFinite(asOfMs) ? asOfMs : null;
        const perSeed = seeds.length > 0
          ? await Promise.all(
              seeds.map((seed) => this.graph!.neighbors(userId, seed, 1, k, seedScope, asOfFilter)),
            )
          : [];
        // Entity bridging, straight from the query text. This is the one
        // graph signal that isn't downstream of the vector tier: it links
        // on exact identifiers, so a query naming `novanas` or
        // `PostgreSQL` reaches memories that neither cosine nor stemmed
        // FTS would surface. Runs alongside the neighbour walk and is
        // unioned into the same signal.
        const queryEntities = extractEntities(req.query);
        const entityHits = queryEntities.length > 0
          ? await this.graph.memoriesByEntities(userId, queryEntities, k * 2, seedScope)
          : [];

        // Union everything, keeping the strongest evidence per id.
        const best = new Map<string, number>();
        for (const hits of [...perSeed, entityHits]) {
          for (const h of hits) {
            const prev = best.get(h.id);
            if (prev === undefined || h.score > prev) best.set(h.id, h.score);
          }
        }
        graphHits = [...best].map(([id, score]) => ({ id, score }));
      } catch (err) {
        degraded = true;
        this.logger.warn({ err: (err as Error).message }, "graph neighbours failed");
      }
    } else {
      degraded = true;
      this.maybeWarnGraphDown();
    }

    // Pre-fetch entries for the UNION of all tier candidate ids so the
    // recency + entity signals (Phase 1 arch-plan additions) can join the
    // fusion. Without this we'd need a second post-fusion pass for the
    // new signals, which would leave them blind to candidates ranked just
    // below the fused-top-k cutoff. One batched lookup keeps it cheap.
    const candidateIds = Array.from(new Set([
      ...keywordHits.map((h) => h.id),
      ...vectorHits.map((h) => h.id),
      ...graphHits.map((h) => h.id),
    ]));
    const candidateEntries = candidateIds.length > 0
      ? await this.warm.getEntries(userId, candidateIds, {
          projectId,
          includeProjects: req.includeProjects,
        })
      : [];
    const entryById = new Map<string, (typeof candidateEntries)[number]>();
    for (let i = 0; i < candidateIds.length; i++) {
      const e = candidateEntries[i];
      if (e) entryById.set(candidateIds[i]!, e);
    }
    const queryEntities = extractQueryEntities(req.query);

    // Over-fetch before the visibility filters below. Superseded and
    // sensitivity-hidden entries used to be dropped *after* slicing to k,
    // so a top-10 containing four superseded rows returned six results
    // and the relevant rank-11..14 memories were never fetched — recall
    // silently shrank in exactly the stores that use supersession most.
    const fusedAll = fuse(
      [
        ...keywordHits.map((h) => ({ id: h.id, signals: { keyword: h.score } })),
        ...vectorHits.map((h) => ({ id: h.id, signals: { vector: h.score } })),
        ...graphHits.map((h) => ({ id: h.id, signals: { graph: h.score } })),
        // Recency: exp(-ageDays / 180). Skipped for entries we couldn't
        // resolve (filtered out by visibility) — they'll drop out anyway.
        ...candidateIds.flatMap((id) => {
          const e = entryById.get(id);
          if (!e?.updatedAt) return [];
          const score = recencyScore(e.updatedAt);
          return score > 0 ? [{ id, signals: { recency: score } }] : [];
        }),
        // Entity match: count of distinct query-entity tokens present in
        // the memory's content text. Catches "answer lives in sibling
        // chunk" cases where the exact noun is in content but cosine
        // didn't score it best.
        ...(queryEntities.length === 0 ? [] : candidateIds.flatMap((id) => {
          const e = entryById.get(id);
          if (!e?.content) return [];
          const score = entityMatchScore(e.content, queryEntities);
          return score > 0 ? [{ id, signals: { entity: score } }] : [];
        })),
      ],
      weights,
      { minVectorScore: req.minVectorScore ?? this.minVectorScore },
    );
    let fused = fusedAll.slice(0, k * OVERFETCH_FACTOR);

    // Arch-plan gap #4: importance-weighted boost for fact memories.
    // Each fact extracted at write time carries metadata.fact.importance
    // (1..5, model-judged). Treat 3 as neutral and multiply the fused
    // score by importance/3 so high-importance facts (4,5) beat noisy
    // low-importance ones (1,2). Raw chunks (sourceType != "fact") get
    // multiplier 1.0 — no penalty. Re-truncate to k after re-sort.
    fused = fused
      .map((f) => {
        const e = entryById.get(f.id);
        const meta = (e?.metadata ?? {}) as Record<string, unknown>;
        const fact = (meta.fact ?? {}) as Record<string, unknown>;
        const imp = typeof fact.importance === "number"
          ? Math.max(1, Math.min(5, fact.importance))
          : 3;
        const boost = imp / 3;
        return { ...f, score: f.score * boost };
      })
      .sort((a, b) => b.score - a.score);
    // Deliberately NOT truncated to k here: the visibility filter below
    // drops superseded / sensitivity-hidden rows, and cutting to k first
    // is exactly the recall bug the over-fetch above exists to prevent.
    // The diversify stage does the final truncation.

    // Arch-plan Phase 4: coherence rerank. When the caller opts into
    // decomposition AND the decomposer is configured AND there are enough
    // candidates to rerank, ask the LLM to put the final top-k in the
    // order best supporting the question. Drops fused candidates the LLM
    // considers irrelevant or duplicative.
    // Rerank the head, not the whole over-fetch pool. `fused` holds up to
    // k * OVERFETCH_FACTOR candidates — 600 at k=200 — and the rerank
    // prompt inlines 600 chars of each, so passing all of them built a
    // ~360KB prompt and asked for a 600-element permutation back inside a
    // 200-token budget and a 12s timeout. It could only ever time out or
    // come back truncated. Reranking is a top-of-list concern anyway:
    // nothing below the cutoff can reach the caller.
    //
    // The head, not `fused`, is what decides whether there is anything to
    // reorder: at k=1 the head is a single candidate even though `fused`
    // holds many.
    const rerankCount = Math.min(fused.length, k, COHERENCE_RERANK_MAX_CANDIDATES);
    if (req.decompose && this.decomposer && rerankCount >= 2) {
      const head = fused.slice(0, rerankCount);
      const tail = fused.slice(rerankCount);
      const memTexts = head.map((f) => entryById.get(f.id)?.content ?? "");
      try {
        const newOrder = await traceAsync(
          "QueryDecomposer.coherenceRerank",
          { "novamem.candidate_count": head.length },
          () => this.decomposer!.coherenceRerank(req.query, memTexts),
        );
        if (newOrder && newOrder.length === head.length) {
          fused = [...newOrder.map((i) => head[i]!), ...tail];
        }
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, "coherenceRerank failed");
      }
    }

    // Re-use the pre-fetched batch — no second round-trip.
    const fusedIds = fused.map((f) => f.id);
    const entries = fusedIds.map((id) => entryById.get(id));
    // Pre-fetch promotion stats for cold hits in one round-trip.
    const coldHitIds: string[] = [];
    for (let i = 0; i < fused.length; i++) {
      const e = entries[i];
      if (e?.cold) coldHitIds.push(fused[i]!.id);
    }
    const coldStats = coldHitIds.length > 0
      ? await this.warm.getColdEntryStatsMany(coldHitIds)
      : new Map<string, { hits: number; idleDays: number }>();

    // ── Visibility filter → rank prior → diversify → truncate ─────────
    // Order matters. Filtering first means the k we finally return is k
    // *visible* results. The rank prior then re-orders near-ties using
    // signals similarity is blind to (confidence, staleness of
    // "current state" memory types). Diversification drops restatements
    // of a fact already present so the agent's context budget isn't
    // spent three times on the same thing.
    const visible: Array<{ result: SearchResult; entry: (typeof entries)[number] }> = [];
    for (let i = 0; i < fused.length; i++) {
      const f = fused[i]!;
      const e = entries[i];
      if (!e) continue;
      const metadata = e.metadata as Record<string, unknown> | null | undefined;
      if (isInactiveMemory(metadata)) continue;
      if (!isSensitivityVisible(metadata, req.maxSensitivity)) continue;

      const ageDays = e.createdAt
        ? (Date.now() - new Date(e.createdAt).getTime()) / 86_400_000
        : null;
      const prior = rankPrior({
        confidence: typeof e.confidence === "number" ? e.confidence : null,
        memoryType: typeof metadata?.memoryType === "string" ? metadata.memoryType : null,
        ageDays,
      });

      visible.push({
        entry: e,
        result: {
          id: f.id,
          score: f.score * prior,
          content: e.content,
          tier: e.cold ? "cold" : "warm",
          namespace: e.namespace,
          project: e.projectId ?? null,
          source: e.source,
          metadata: (e.metadata ?? {}) as Record<string, unknown>,
          signals: f.signals,
        },
      });
    }
    visible.sort((a, b) => b.result.score - a.result.score);

    // Greedy redundancy filter (MMR-style, using token overlap as the
    // similarity measure so no extra vector fetches are needed): keep a
    // candidate only if it isn't a restatement of one already selected.
    // Token sets are memoised — the comparison is O(selected × visible),
    // and re-tokenising the same content on every pair is pure waste.
    const tokenCache = new Map<string, Set<string>>();
    const tokensFor = (content: string): Set<string> => {
      let t = tokenCache.get(content);
      if (!t) {
        t = contentTokens(content);
        tokenCache.set(content, t);
      }
      return t;
    };
    const selected: typeof visible = [];
    for (const cand of visible) {
      if (selected.length >= k) break;
      const candTokens = tokensFor(cand.result.content);
      const redundant = selected.some(
        (s) => jaccardOf(tokensFor(s.result.content), candTokens) >= RESULT_DIVERSITY_MAX_JACCARD,
      );
      if (!redundant) selected.push(cand);
    }
    // If diversification starved the result set (a store legitimately
    // full of similar short facts), backfill from what it dropped rather
    // than under-returning.
    if (selected.length < k) {
      const chosen = new Set(selected.map((s) => s.result.id));
      for (const cand of visible) {
        if (selected.length >= k) break;
        if (!chosen.has(cand.result.id)) selected.push(cand);
      }
      // Backfilled candidates are appended after the diversified set, so
      // the array is no longer in score order — a redundant high scorer
      // would sit behind a lower-scoring unique one. Callers (and the
      // "is the top hit good enough?" heuristic) rely on descending
      // score, so restore it.
      selected.sort((a, b) => b.result.score - a.result.score);
    }

    const results: SearchResult[] = [];
    const idsToBump: string[] = [];
    const promotionTasks: Array<Promise<{ id: string; promoted: boolean }>> = [];
    for (const { result, entry } of selected) {
      idsToBump.push(result.id);
      // Cold→warm promotion: capture stats *before* bumpHits so the
      // pre-hit idle age is what gates promotion — otherwise every hit
      // would trivially clear an idle gap of zero. The `markCold(false)`
      // writes still happen one-per-promotion, but the read side is now
      // a single query for the whole cold slice. Only entries actually
      // returned to the caller count as "hit" — over-fetched candidates
      // that never surfaced must not bump hit counts or trigger
      // promotion, or the decay maths would drift on every search.
      if (entry?.cold) {
        const preBump = coldStats.get(result.id) ?? null;
        promotionTasks.push(
          this.maybePromote(result.id, preBump).then((promoted) => ({ id: result.id, promoted })),
        );
      }
      results.push(result);
    }
    // Run all cold→warm flips in parallel and apply tier upgrades to the
    // already-built result rows. Failures are swallowed by maybePromote
    // upstream of here (it returns false on no-op); this layer just
    // surfaces the post-promotion tier on the response.
    if (promotionTasks.length > 0) {
      const promotionOutcomes = await Promise.all(promotionTasks);
      const promotedSet = new Set(
        promotionOutcomes.filter((p) => p.promoted).map((p) => p.id),
      );
      if (promotedSet.size > 0) {
        for (const r of results) if (promotedSet.has(r.id)) r.tier = "warm";
      }
    }
    if (idsToBump.length > 0) await this.warm.bumpHitsMany(idsToBump);

    // ── Arch-plan gap-closer: auto-expand source_chunk for fact memories ──
    // Each extracted-fact memory carries metadata.source_chunk_id pointing
    // to the raw chunk it was distilled from. Inlining that chunk's text
    // into the response lets answerer LLMs see both the compressed fact
    // AND the supporting conversation, which is critical for multi-item
    // counting and rich preference questions. Validated +10pp at k=50 on
    // the LongMemEval 40q slice when done client-side; promoting it here
    // so every caller benefits.
    if (req.expandSourceChunks !== false) {
      const sourceIds = Array.from(new Set(
        results
          .map((r) => (r.metadata as { source_chunk_id?: string } | undefined)?.source_chunk_id)
          .filter((x): x is string => typeof x === "string"),
      ));
      if (sourceIds.length > 0) {
        try {
          const srcRows = await this.warm.getEntries(userId, sourceIds, {
            projectId,
            includeProjects: req.includeProjects,
          });
          const byId = new Map<string, string>();
          for (let i = 0; i < sourceIds.length; i++) {
            const row = srcRows[i];
            if (row) byId.set(sourceIds[i]!, row.content);
          }
          for (const r of results) {
            const meta = r.metadata as { source_chunk_id?: string; sourceText?: string };
            const srcId = meta?.source_chunk_id;
            if (srcId && byId.has(srcId)) {
              r.metadata = { ...meta, sourceText: byId.get(srcId)! };
            }
          }
        } catch (err) {
          this.logger.warn(
            { err: (err as Error).message },
            "source-chunk auto-expand failed (returning facts without sourceText)",
          );
        }
      }
    }

    // Per-tier hit counts: each result may have contributed via more than
    // one signal (e.g. keyword + vector), and we count every contributing
    // signal — that's the operator-visible "this tier carried weight".
    // Naming: warmCount=keyword (FTS), coldCount=vector (cold store),
    // graphCount=graph. The earlier "graphHits" alias shadowed the outer
    // graph-hit array; renamed to break the conflation between "cold tier"
    // and "vector signal".
    if (this.metrics) {
      const signalCounts = { keyword: 0, vector: 0, graph: 0 };
      for (const f of results) {
        if (f.signals?.keyword) signalCounts.keyword++;
        if (f.signals?.vector) signalCounts.vector++;
        if (f.signals?.graph) signalCounts.graph++;
      }
      this.metrics.recordQuery(
        userId,
        { warm: signalCounts.keyword, cold: signalCounts.vector, graph: signalCounts.graph },
        token,
      );
    }
    span.setAttribute("novamem.result_count", results.length);
    span.setAttribute("novamem.degraded", degraded);
    this.metrics?.recordLatency("search", Date.now() - searchStartedAt);
    return { results, degraded };
    }).catch((err) => {
      // Errors were previously invisible to the dashboard: recordQuery
      // only fires on success, so a failing search tier showed up as
      // throughput quietly dropping to zero.
      this.metrics?.recordError("search");
      throw err;
    });
  }

  async decay(opts: { effectiveDaysOverride?: number } = {}): Promise<{ demoted: number; promoted: number }> {
    // For each warm entry, compare idle age (days since last access) against
    // its effective lifespan: `7 × log₂(hits+1)` — frequently-used memories
    // resist decay because their lifespan grows with use. Override the
    // default 7-day base via `effectiveDaysOverride` for one-shot passes.
    const baseDays = opts.effectiveDaysOverride ?? this.defaultDecayDays;
    const startedAt = new Date();
    const runRow = await this.warm.pool.query<{ id: number }>(
      `INSERT INTO decay_runs (started_at, effective_days) VALUES ($1, $2) RETURNING id`,
      [startedAt, baseDays],
    );
    const runId = runRow.rows[0]?.id;
    // Bulk SQL replaces a per-row loop. The lifespan formula lives
    // in `EFFECTIVE_LIFESPAN_SQL` next to the JS `effectiveDays` so the
    // two stay in lockstep — substituting `$1::double precision` for the
    // `$BASE` placeholder yields `($1::double precision) * log(2.0,
    // GREATEST(hits, 0) + 1)`, the SQL twin of `effectiveDays(hits)` (with
    // the `7` parameterised so a one-shot pass can override). Demote when
    // `idle_days > lifespan`. One round-trip regardless of candidate count.
    const lifespanSql = EFFECTIVE_LIFESPAN_SQL.replace("$BASE", "$1::double precision");
    const r = await this.warm.pool.query<{ id: string }>(
      `WITH candidates AS (
         SELECT e.id,
                COALESCE(a.hits, 0) AS hits,
                EXTRACT(EPOCH FROM (now() - COALESCE(a.last_accessed, e.created_at))) / 86400.0 AS idle_days,
                COALESCE(NULLIF(e.metadata->'retention'->>'baseEffectiveDays', '')::double precision, $1::double precision) AS base_days
           FROM memory_entries e
           LEFT JOIN memory_access a ON a.entry_id = e.id
          WHERE e.cold = false
       ),
       to_demote AS (
         SELECT id FROM candidates
          WHERE idle_days > (base_days * log(2.0, GREATEST(hits, 0) + 1))
       )
       UPDATE memory_entries
          SET cold = true, updated_at = now()
        WHERE id IN (SELECT id FROM to_demote)
        RETURNING id`,
      [baseDays],
    );
    const demoted = r.rowCount ?? 0;
    if (runId !== undefined) {
      await this.warm.pool.query(
        `UPDATE decay_runs SET finished_at = now(), demoted = $1, promoted = $2 WHERE id = $3`,
        [demoted, this.promotedSinceLastDecay, runId],
      );
    }
    const promoted = this.promotedSinceLastDecay;
    this.promotedSinceLastDecay = 0;
    if (this.metrics) {
      this.metrics.markDecayRun();
      this.metrics.recordDemotion(demoted);
    }
    return { demoted, promoted };
  }

  /** Recent entries in a namespace, ordered newest first. Optional `since`
   *  ISO-8601 lower bound for time-windowed queries ("since yesterday"). */
  async recent(
    userId: string,
    args: {
      namespace?: string;
      k?: number;
      since?: string;
      project?: string | null;
      includeProjects?: string[];
      includeNamespaces?: string[];
      maxSensitivity?: SensitivityLevel;
    },
  ): Promise<{ results: SearchResult[] }> {
    // See engine.search for the reasoning behind the no-arg fanout.
    // recent() obeys the same rules: explicit namespace param wins;
    // includeNamespaces wins over that; otherwise resolve the user's
    // populated namespaces in-scope and fall back to ["default"] only
    // when there's nothing yet.
    const projectId = args.project ?? null;
    const includeProjects = args.includeProjects ?? null;
    const recentScopes: Array<string | null> = includeProjects?.length
      ? [null, ...includeProjects]
      : [projectId];
    const namespaces = args.includeNamespaces?.length
      ? args.includeNamespaces
      : args.namespace
        ? [args.namespace]
        : await this.resolveDefaultNamespaces(userId, recentScopes);
    const k = args.k ?? 20;
    // Isolation matches ftsSearch / getEntry / getEntries — see
    // `WarmStore.listRecent` for the breakdown. Engine just maps the
    // request shape onto the store call and converts entry rows into
    // SearchResult shape. `signals` is intentionally omitted: recent()
    // is ordered, not ranked, so "no signal" is the truth — fabricating
    // `{keyword:0, vector:0, graph:0}` would misrepresent it as
    // "scored zero" and is what consumers used to (incorrectly) read.
    const rows = await this.warm.listRecent(userId, {
      namespaces,
      k,
      projectId,
      includeProjects,
      since: args.since ? new Date(args.since) : null,
    });
    const results: SearchResult[] = rows
      .filter((r) => !isInactiveMemory((r.metadata ?? {}) as Record<string, unknown>))
      .filter((r) => isSensitivityVisible((r.metadata ?? {}) as Record<string, unknown>, args.maxSensitivity))
      .map((r) => ({
        id: r.id,
        score: 1.0,
        content: r.content,
        tier: r.cold ? ("cold" as const) : ("warm" as const),
        namespace: r.namespace,
        project: r.projectId,
        source: r.source,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
      }));
    return { results };
  }

  /** Graph-neighbour traversal from a seed memory id. Depth defaults to 1. */
  async neighbors(
    userId: string,
    args: {
      id: string;
      depth?: number;
      k?: number;
      project?: string | null;
      includeProjects?: string[];
      /** Accepted for API symmetry with search/recent but not used by the
       *  graph store — Memory nodes aren't namespaced; entry resolution
       *  picks up the entry's actual namespace from Postgres. */
      includeNamespaces?: string[];
      maxSensitivity?: SensitivityLevel;
    },
  ): Promise<{ results: SearchResult[]; degraded: boolean }> {
    const depth = args.depth ?? 1;
    const k = args.k ?? 10;
    const projectId = args.project ?? null;
    const includeProjects = args.includeProjects;
    if (!this.graph?.isConnected()) return { results: [], degraded: true };
    // Cross-user + cross-project guard. In active-project mode the seed
    // may belong to user-global or any included project — resolve it once
    // and bind further traversal to its actual scope.
    const seedRows = includeProjects?.length
      ? await this.warm.getEntries(userId, [args.id], { includeProjects })
      : [await this.warm.getEntry(userId, args.id, { projectId })];
    const seedEntry = seedRows[0];
    if (!seedEntry) return { results: [], degraded: false };
    const seedScope = seedEntry.projectId ?? null;
    // FalkorDB occasionally surfaces driver-side decode errors for
    // certain depth/topology combinations ("expected List or Null but
    // was Path/Edge"). Treat those the same as an unreachable graph —
    // return empty + degraded:true — so the data-plane (/v1/search)
    // and /v1/neighbors don't 500. The Cypher we emit at depth
    // ≤ 1 and ≥ 2 is structured to avoid these decode hits in the
    // common case; this guard catches the long tail.
    let hits: Array<{ id: string; score: number }>;
    try {
      hits = await this.graph.neighbors(userId, args.id, depth, k, seedScope);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, depth, seedId: args.id },
        "[engine.neighbors] graph driver error — returning degraded",
      );
      return { results: [], degraded: true };
    }
    const results: SearchResult[] = [];
    for (const h of hits) {
      const e = includeProjects?.length
        ? (await this.warm.getEntries(userId, [h.id], { includeProjects }))[0]
        : await this.warm.getEntry(userId, h.id, { projectId });
      if (!e) continue;
      if (!isSensitivityVisible(e.metadata as Record<string, unknown> | null | undefined, args.maxSensitivity)) continue;
      results.push({
        id: h.id,
        score: h.score,
        content: e.content,
        tier: e.cold ? "cold" : "warm",
        namespace: e.namespace,
        project: e.projectId ?? null,
        source: e.source,
        metadata: (e.metadata ?? {}) as Record<string, unknown>,
        // Only the graph signal is applicable here; keyword / vector
        // are omitted so consumers can tell "not applicable" from
        // "scored zero".
        signals: { graph: h.score },
      });
    }
    return { results, degraded: false };
  }

  /** Explicit deletion. Removes warm row, FTS shadow, cold vector, graph
   *  edges. Idempotent — missing ids return `deleted:false`. The access
   *  check is the `getEntry` above: it returns `undefined` for cross-user
   *  ids and (for project-scoped queries) for entries in a different
   *  project. The DELETEs that follow MUST scope by the same boundary:
   *  when the entry is project-scoped, scope by project_id (NOT
   *  user_id, because cross-user project members must be able to
   *  delete shared rows); when user-wide, scope by user_id. */
  async forget(
    userId: string,
    id: string,
    opts: { project?: string | null; token?: TokenIdentity } = {},
  ): Promise<{ deleted: boolean; coldDeleteOk: boolean }> {
    const e = await this.warm.getEntry(userId, id, { projectId: opts.project ?? null });
    if (!e) return { deleted: false, coldDeleteOk: true };
    this.metrics?.recordForget(userId, opts.token);
    const pool = this.warm.pool;
    const isProject = e.projectId !== null;
    // Scope clause for the by-id DELETEs. When the row is project-scoped,
    // project_id = entry's project_id is the correct access boundary;
    // user_id is decorative (and may differ from the bearer's owning user
    // for shared projects). When user-wide, user_id is the boundary.
    const scopeClause = isProject ? "project_id = $2" : "user_id = $2";
    const scopeValue = isProject ? e.projectId! : userId;
    // One transaction for all four deletes. As four independent
    // statements, a failure part-way through left the store internally
    // inconsistent in a way nothing repairs — e.g. the FTS shadow gone
    // but the entry alive (still returned by vector search, still
    // readable by id), or the entry gone but its relations dangling.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM memory_fts WHERE entry_id = $1 AND ${scopeClause}`,
        [id, scopeValue],
      );
      await client.query("DELETE FROM memory_access WHERE entry_id = $1", [id]);
      await client.query(
        `DELETE FROM memory_relations
          WHERE (from_id = $1 OR to_id = $1) AND ${scopeClause}`,
        [id, scopeValue],
      );
      await client.query(
        `DELETE FROM memory_entries WHERE id = $1 AND ${scopeClause}`,
        [id, scopeValue],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (this.graph?.isConnected()) {
      try {
        await this.graph.removeNode(userId, id);
      } catch (err) {
        this.logger.warn(
          { entryId: id, err: (err as Error).message },
          "forget: graph removeNode failed",
        );
      }
    }
    let coldDeleteOk = true;
    try {
      await this.cold.delete(userId, e.namespace, id, e.projectId ?? null);
    } catch (err) {
      // Warm row is already gone; cold vector is orphaned. Park the id in
      // cold_orphans; the reaper retries on the decay schedule until the
      // qdrant delete succeeds. The orphan row carries user_id so the
      // reaper knows which collection to delete from.
      coldDeleteOk = false;
      const message = (err as Error).message;
      this.logger.warn(
        { entryId: id, err: message },
        "forget: cold vector survived; queued for reaper",
      );
      await pool.query(
        `INSERT INTO cold_orphans (id, user_id, namespace, project_id, attempts, last_error, last_attempt_at)
         VALUES ($1, $2, $3, $4, 1, $5, now())
         ON CONFLICT (id) DO UPDATE SET
           attempts = cold_orphans.attempts + 1,
           last_error = EXCLUDED.last_error,
           last_attempt_at = now()`,
        [id, userId, e.namespace, e.projectId ?? null, message],
      );
    }
    return { deleted: true, coldDeleteOk };
  }

  /** Re-embed and re-upsert a warm entry whose cold vector never landed.
   *  Throws on failure so the caller's retry/abandon accounting applies.
   *  A row whose warm entry has since been deleted is not an error — the
   *  queue entry is simply obsolete, so we return and let it be cleared. */
  private async backfillOrphanVector(r: {
    id: string;
    user_id: string;
    namespace: string;
    project_id: string | null;
  }): Promise<void> {
    const entry = await this.warm.getEntry(r.user_id, r.id, { projectId: r.project_id });
    if (!entry) return;
    const [embedding] = await this.embedder.embed(entry.content, "document");
    if (!embedding) throw new Error("embedder returned no vector during backfill");
    await this.cold.upsert({
      userId: r.user_id,
      projectId: r.project_id,
      id: r.id,
      namespace: entry.namespace,
      embedding,
      payload: {
        source: entry.source,
        agentName: entry.agentName ?? null,
        embeddingModel: this.embedder.modelId,
      },
    });
  }

  /** Reaper pass: retries each queued orphan's cold-store repair — a
   *  delete for vectors that outlived their warm row, a re-embed for warm
   *  rows whose vector never landed — and removes it from the queue on
   *  success. Called from the decay loop and exposed at /v1/reap-orphans
   *  for manual triggers. Returns counts so operators can tell how much
   *  drift was cleaned up. */
  async reapOrphans(opts: { maxAttempts?: number; limit?: number } = {}): Promise<{
    attempted: number;
    cleared: number;
    abandoned: number;
    pending: number;
    total: number;
  }> {
    const maxAttempts = opts.maxAttempts ?? 10;
    const limit = opts.limit ?? 100;
    const rows = await this.warm.pool.query<{
      id: string;
      user_id: string;
      namespace: string;
      project_id: string | null;
      attempts: number;
      kind: string;
    }>(
      `SELECT id, user_id, namespace, project_id, attempts, kind FROM cold_orphans
        WHERE attempts < $1
        ORDER BY last_attempt_at ASC NULLS FIRST
        LIMIT $2`,
      [maxAttempts, limit],
    );
    let cleared = 0;
    let abandoned = 0;
    for (const r of rows.rows) {
      try {
        if (r.kind === "backfill") {
          await this.backfillOrphanVector(r);
        } else {
          await this.cold.delete(r.user_id, r.namespace, r.id, r.project_id);
        }
        await this.warm.pool.query(`DELETE FROM cold_orphans WHERE id = $1`, [r.id]);
        cleared++;
      } catch (err) {
        const message = (err as Error).message;
        const newAttempts = r.attempts + 1;
        await this.warm.pool.query(
          `UPDATE cold_orphans SET attempts = $1, last_error = $2, last_attempt_at = now() WHERE id = $3`,
          [newAttempts, message, r.id],
        );
        if (newAttempts >= maxAttempts) {
          abandoned++;
          this.logger.warn(
            { entryId: r.id, attempts: newAttempts, err: message },
            "cold orphan abandoned",
          );
        }
      }
    }
    // Two counters so operators see both retry-eligible work AND the
    // permanently-stuck tail: `pending` excludes abandoned, `total` is the
    // full queue depth incl. abandoned rows still on disk.
    const counts = await this.warm.pool.query<{ pending: string; total: string }>(
      `SELECT COUNT(*) FILTER (WHERE attempts < $1)::text AS pending,
              COUNT(*)::text AS total
         FROM cold_orphans`,
      [maxAttempts],
    );
    const row = counts.rows[0];
    if (cleared > 0) this.metrics?.recordOrphansReaped(cleared);
    return {
      attempted: rows.rows.length,
      cleared,
      abandoned,
      pending: Number(row?.pending ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  /** Dream cycle — periodic compaction. Runs in two phases:
   *
   *    1. Dedup-merge: for each entry, find vector-near neighbours via
   *       cold.search, accept a pair as duplicate when cosine ≥ 0.97
   *       AND token-set Jaccard ≥ 0.5 (both required so contradictions
   *       like "lives in X" / "lives in Y" don't merge). Pick the
   *       canonical (most hits, oldest tiebreak), redirect graph edges
   *       to the canonical id, sum hit counts, delete the duplicate.
   *
   *    2. Edge promotion: when two memories share ≥3 graph neighbours
   *       in common, add a direct A→B edge with relation = co_inferred
   *       so search picks up transitive connections. Tagged distinctly
   *       from the original co_occurs so search ranking can dial it
   *       back if the inferred edges turn out to be noisy.
   *
   *  Runs cross-user — operates on whatever rows exist. */
  async dreamCycle(opts: {
    cosineThreshold?: number;
    jaccardThreshold?: number;
    edgePromotionMinCommon?: number;
    /** Cap rows-walked-per-run so a huge store doesn't pin a worker
     *  for an hour. Default 5000. */
    maxEntries?: number;
  } = {}): Promise<{
    walked: number;
    merged: number;
    edgesPromoted: number;
    durationMs: number;
  }> {
    const cosineMin = opts.cosineThreshold ?? 0.97;
    const jaccardMin = opts.jaccardThreshold ?? 0.5;
    const minCommon = opts.edgePromotionMinCommon ?? 3;
    const limit = opts.maxEntries ?? 5000;
    const startedAt = Date.now();
    let walked = 0;
    let merged = 0;
    const mergedSet = new Set<string>();

    // ── Phase 1: dedup-merge ────────────────────────────────────────
    // Walk forward from where the last run stopped instead of always
    // re-reading the oldest `limit` rows. The old query
    // (`ORDER BY created_at ASC LIMIT n`, no offset) meant a store with
    // more than `limit` entries never compacted anything newer than its
    // oldest slice, while re-embedding that same slice on every cycle.
    // Entry ids are ULIDs, so `id > cursor` is both creation-ordered and
    // an index range scan on the primary key. Running out of rows wraps
    // the cursor back to the start, so coverage is a continuous loop
    // over the whole table.
    if (this.dreamCursor === null) {
      this.dreamCursor = (await this.warm.getEngineState(DREAM_CURSOR_KEY).catch(() => null)) ?? "";
    }
    const rows = await this.warm.pool.query<{
      id: string;
      user_id: string;
      project_id: string | null;
      namespace: string;
      content: string;
    }>(
      `SELECT id, user_id, project_id, namespace, content
         FROM memory_entries
        WHERE id > $2
        ORDER BY id ASC
        LIMIT $1`,
      [limit, this.dreamCursor],
    );
    // Advance (or wrap) before doing the work, so a mid-run failure
    // doesn't pin the cycle to the same slice forever.
    this.dreamCursor = rows.rows.length < limit ? "" : (rows.rows[rows.rows.length - 1]?.id ?? "");
    await this.warm.setEngineState(DREAM_CURSOR_KEY, this.dreamCursor).catch((err) => {
      // Non-fatal: the cycle still runs, it just may repeat this slice
      // after a restart.
      this.logger.warn(
        { err: (err as Error).message },
        "could not persist dream-cycle cursor",
      );
    });
    for (const row of rows.rows) {
      walked++;
      // Skip ones we've already merged this run.
      if (mergedSet.has(row.id)) continue;
      const [embedding] = await this.embedder.embed(row.content);
      if (!embedding) continue;
      let neighbours: Array<{ id: string; score: number }> = [];
      try {
        neighbours = await this.cold.search({
          userId: row.user_id,
          projectId: row.project_id,
          namespace: row.namespace,
          embedding,
          k: 4,
        });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, "dream cold.search failed");
        continue;
      }
      for (const n of neighbours) {
        if (n.id === row.id) continue;
        if (mergedSet.has(n.id)) continue;
        if (n.score < cosineMin) continue;
        const other = await this.warm.getEntry(row.user_id, n.id, {
          projectId: row.project_id,
        });
        if (!other) continue;
        if (tokenJaccard(row.content, other.content) < jaccardMin) continue;
        // Pick canonical: prefer the one with more hits, oldest as
        // tiebreak. Sum hits onto the canonical, redirect edges,
        // delete the loser.
        const rowStats = await this.warm.getColdEntryStats(row.id);
        const otherStats = await this.warm.getColdEntryStats(n.id);
        const rowHits = rowStats?.hits ?? 0;
        const otherHits = otherStats?.hits ?? 0;
        const rowOlder = (await this.warm.getEntry(row.user_id, row.id, {
          projectId: row.project_id,
        }))!.createdAt < other.createdAt;
        const keepRow =
          rowHits > otherHits || (rowHits === otherHits && rowOlder);
        const keepId = keepRow ? row.id : n.id;
        const dropId = keepRow ? n.id : row.id;
        // The dream cycle already knows the dropped row's namespace —
        // it's either `row.namespace` (when `dropId === row.id`) or
        // `other.namespace` (when the neighbour lost). Pass it through
        // so `mergeEntries` doesn't re-SELECT it.
        const dropNamespace = dropId === row.id ? row.namespace : other.namespace;
        try {
          await this.mergeEntries(row.user_id, row.project_id, keepId, dropId, dropNamespace);
          merged++;
          mergedSet.add(dropId);
          if (dropId === row.id) break; // current row was the loser
        } catch (err) {
          this.logger.warn(
            { dropId, keepId, err: (err as Error).message },
            "dream merge failed",
          );
        }
      }
    }

    // ── Phase 2: edge promotion ─────────────────────────────────────
    const promoted = await this.promoteCommonNeighborEdges(minCommon);

    return {
      walked,
      merged,
      edgesPromoted: promoted,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Helper for dreamCycle: merge `dropId` into `keepId`. Sums hits,
   *  redirects graph edges, deletes the warm row + cold vector + memory_fts
   *  shadow + memory_access counter for `dropId`. */
  private async mergeEntries(
    userId: string,
    projectId: string | null,
    keepId: string,
    dropId: string,
    dropNamespace: string,
  ): Promise<void> {
    const pool = this.warm.pool;
    // Sum hit counts onto the canonical.
    await pool.query(
      `UPDATE memory_access SET hits = hits + COALESCE(
         (SELECT hits FROM memory_access WHERE entry_id = $2), 0
       ),
       last_accessed = greatest(last_accessed,
         COALESCE((SELECT last_accessed FROM memory_access WHERE entry_id = $2), last_accessed))
       WHERE entry_id = $1`,
      [keepId, dropId],
    );
    // Redirect inbound + outbound graph edges to the canonical.
    await pool.query(
      `UPDATE memory_relations SET to_id = $1 WHERE to_id = $2 AND from_id <> $1`,
      [keepId, dropId],
    );
    await pool.query(
      `UPDATE memory_relations SET from_id = $1 WHERE from_id = $2 AND to_id <> $1`,
      [keepId, dropId],
    );
    await pool.query(
      `DELETE FROM memory_relations WHERE from_id = $1 OR to_id = $1`,
      [dropId],
    );
    // Drop the FTS shadow + access counter + warm row + cold vector.
    await pool.query(`DELETE FROM memory_fts WHERE entry_id = $1`, [dropId]);
    await pool.query(`DELETE FROM memory_access WHERE entry_id = $1`, [dropId]);
    // Caller already has the namespace — no SELECT needed.
    const namespace = dropNamespace;
    await pool.query(`DELETE FROM memory_entries WHERE id = $1`, [dropId]);
    if (this.graph?.isConnected()) {
      try {
        await this.graph.removeNode(userId, dropId);
      } catch (err) {
        this.logger.warn(
          { dropId, err: (err as Error).message },
          "dream graph removeNode failed",
        );
      }
    }
    try {
      await this.cold.delete(userId, namespace, dropId, projectId);
    } catch (err) {
      this.logger.warn(
        { dropId, err: (err as Error).message },
        "dream cold.delete failed",
      );
    }
  }

  /** Edge promotion: for any pair (A, B) of memories that share at
   *  least `minCommon` graph neighbours, add a direct A→B edge with
   *  relation=co_inferred. Uses a single SQL pass that picks the top
   *  candidates by common-neighbour count; cheap on most stores. */
  private async promoteCommonNeighborEdges(minCommon: number): Promise<number> {
    // Defensive user + project isolation in SQL. The JOIN with
    // `memory_entries` enforces that `r1.from_id` and `r2.from_id` belong
    // to the same user AND the same project (treating NULL projects as
    // equal via COALESCE). The same-user invariant holds in practice for
    // co_occurs edges (cold-store-derived, always same-user), but pinning
    // it here means a future code path that adds cross-user co_occurs
    // edges can't accidentally bleed inferences across users.
    const r = await this.warm.pool.query(
      `WITH co AS (
         SELECT r1.from_id AS a, r2.from_id AS b,
                ea.user_id AS user_id,
                COUNT(*) AS c
           FROM memory_relations r1
           JOIN memory_relations r2
             ON r1.to_id = r2.to_id
            AND r1.from_id <> r2.from_id
           JOIN memory_entries ea ON ea.id = r1.from_id
           JOIN memory_entries eb ON eb.id = r2.from_id
          WHERE r1.relation = 'co_occurs'
            AND r2.relation = 'co_occurs'
            AND ea.user_id = eb.user_id
            AND COALESCE(ea.project_id, '') = COALESCE(eb.project_id, '')
          GROUP BY r1.from_id, r2.from_id, ea.user_id
         HAVING COUNT(*) >= $1
       )
       INSERT INTO memory_relations (user_id, from_id, to_id, relation, strength)
       SELECT co.user_id, co.a, co.b,
              'co_inferred', LEAST(0.5 + (co.c::real / 20.0), 0.9)
         FROM co
       ON CONFLICT (from_id, to_id, relation) DO NOTHING`,
      [minCommon],
    );
    return r.rowCount ?? 0;
  }

  /** Delete a project + every memory artefact owned by it (warm rows,
   *  cold collections, graph nodes, project-scoped tokens, members).
   *  Does NOT enforce permissions — the HTTP layer must verify the
   *  caller is the project owner before invoking this. */
  async deleteProject(
    projectId: string,
    ownerUserId: string,
  ): Promise<{
    deleted: boolean;
    entriesRemoved: number;
    coldCollectionsDropped: string[];
    graphCleared: boolean;
  }> {
    const warm = await this.warm.deleteProject(projectId);
    if (!warm.deleted) {
      return { deleted: false, entriesRemoved: 0, coldCollectionsDropped: [], graphCleared: false };
    }
    let coldCollectionsDropped: string[] = [];
    try {
      coldCollectionsDropped = await this.cold.deleteAllForProject(projectId);
    } catch (err) {
      this.logger.warn(
        { projectId, err: (err as Error).message },
        "deleteProject: cold cleanup failed",
      );
    }
    let graphCleared = false;
    if (this.graph?.isConnected()) {
      // Defence-in-depth: scope the delete to the owner's user namespace
      // (issue #45). Project-scoped graph nodes outside the owner's
      // namespace are left for the dream-cycle / orphan reaper to mop up.
      graphCleared = await this.graph.removeAllForProject({
        userId: ownerUserId,
        projectId,
      });
    }
    return {
      deleted: true,
      entriesRemoved: warm.entriesRemoved,
      coldCollectionsDropped,
      graphCleared,
    };
  }

  async stats(userId: string): Promise<MemoryStats> {
    const s = await this.warm.stats(userId);
    const byNamespace: Record<string, { warm: number; cold: number }> = {};
    let totalWarm = 0;
    let totalCold = 0;
    for (const r of s.rows) {
      const slot = (byNamespace[r.namespace] ??= { warm: 0, cold: 0 });
      const n = Number(r.count);
      if (r.cold) {
        slot.cold += n;
        totalCold += n;
      } else {
        slot.warm += n;
        totalWarm += n;
      }
    }
    return {
      byNamespace,
      totalWarm,
      totalCold,
      lastDecayAt: s.lastDecayAt ? s.lastDecayAt.toISOString() : null,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  buildContextPack(relevant: SearchResult[], recent: SearchResult[]): ContextPack {
    const byId = new Map<string, SearchResult>();
    for (const item of [...relevant, ...recent]) byId.set(item.id, item);
    const all = [...byId.values()];
    const byType = (types: string[], extra?: (r: SearchResult) => boolean) =>
      all.filter((r) => types.includes(String(r.metadata?.memoryType ?? "")) || Boolean(extra?.(r)));
    return {
      userGlobal: all.filter((r) => r.project === null),
      projectScoped: all.filter((r) => r.project !== null),
      userPreferences: byType(["user_preference"], (r) => r.namespace === "user"),
      currentSetup: byType(["setup_fact", "deployment_state"], (r) => ["current-setup", "setup"].includes(r.namespace)),
      projectConventions: byType(["project_convention"]),
      decisions: byType(["decision"], (r) => r.namespace === "decisions"),
      bugRootCauses: byType(["bug_root_cause"]),
      deploymentState: byType(["deployment_state"]),
      safetyConstraints: byType(["safety_constraint"]),
      pitfalls: all.filter((r) => /pitfall|warning|avoid|do not|don't|must not|gotcha/i.test(r.content)),
      recentDecisions: recent.filter((r) => String(r.metadata?.memoryType ?? "") === "decision" || /\bdecision\b/i.test(r.content)),
      all,
    };
  }

  /** Arch-plan Phase 5: return the cacheable observation prefix for a
   *  (user, project) scope. Returns `null` when no observer is wired —
   *  the route surfaces that as a 404. */
  async getContextPrefix(userId: string, projectId: string | null): Promise<string | null> {
    if (!this.observer) return null;
    return this.observer.getPrefix(userId, projectId);
  }

  /** Arch-plan Phase 5: run an observer + (conditional) reflector pass.
   *  Pulls the N most-recent raw memories in scope, asks the LLM to
   *  convert them to dated bullets, appends to the persisted observation
   *  log, and (if the log grew past reflectThreshold) asks the LLM to
   *  collapse + supersede across the whole log. Returns counts.  */
  async runObserver(
    userId: string,
    projectId: string | null,
    opts: { limit?: number } = {},
  ): Promise<{ observed: number; reflected: boolean; logChars: number } | null> {
    if (!this.observer) return null;
    const limit = opts.limit ?? 20;
    // Pull recent raw memories (skip the observer-managed namespace).
    const rows = await this.warm.listRecent(userId, {
      namespaces: ["default"],
      k: limit,
      projectId,
    });
    const visible = rows.filter((r) => r.namespace !== "__observation__");
    const newBullets = visible.length > 0
      ? await this.observer.observe(userId, projectId, visible.map((r) => r.content))
      : "";
    const existing = await this.observer.getPrefix(userId, projectId);
    let combined = (existing + (existing && newBullets ? "\n" : "") + newBullets).trim();
    let reflected = false;
    if (combined.split("\n").length > 50) {
      const compacted = await this.observer.reflect(combined);
      if (compacted.trim()) {
        combined = compacted.trim();
        reflected = true;
      }
    }
    if (combined) await this.observer.upsertPrefix(userId, projectId, combined);
    return { observed: visible.length, reflected, logChars: combined.length };
  }

  async hygieneReport(userId: string, opts: { k?: number } = {}): Promise<Record<string, unknown>> {
    const k = opts.k ?? 20;
    const scanLimit = Math.max(k * 20, 100);
    const rows = (await this.warm.listHygieneEntries(userId, { k: scanLimit }))
      .filter((r) => !isInactiveMemory((r.metadata ?? {}) as Record<string, unknown>));
    const lowValue = rows
      .filter((r) => Number((r.metadata?.worthiness as any)?.overall ?? 1) < 0.35 || r.content.trim().length < 20)
      .slice(0, k)
      .map((r) => ({ id: r.id, content: r.content, reason: "low_worthiness" }));
    const duplicateClusters: Array<{ ids: string[]; reason: string }> = [];
    const contradictionCandidates: Array<{ ids: string[]; reason: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!, b = rows[j]!;
        if (a.namespace !== b.namespace || (a.projectId ?? null) !== (b.projectId ?? null)) continue;
        const jac = tokenJaccard(a.content, b.content);
        if (jac >= 0.5) duplicateClusters.push({ ids: [a.id, b.id], reason: "high_token_overlap" });
        if (looksContradictory(a.content, b.content)) contradictionCandidates.push({ ids: [a.id, b.id], reason: "comparable_scalar_conflict" });
      }
    }
    const coldIds = await this.cold.existingIds(rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      projectId: r.projectId ?? null,
      namespace: r.namespace,
    })));
    const orphanCandidates = rows
      .filter((r) => !coldIds.has(r.id))
      .slice(0, k)
      .map((r) => ({ id: r.id, reason: "warm_without_cold_vector" }));
    const stale = rows
      .filter((r) => ["setup_fact", "deployment_state"].includes(String(r.metadata?.memoryType ?? "")) && !String(r.metadata?.lifecycleStatus ?? "active").match(/superseded|deprecated/))
      .slice(0, k)
      .map((r) => ({ id: r.id, reason: "current_state_review" }));
    const report = { lowValue, stale, duplicateClusters: duplicateClusters.slice(0, k), contradictionCandidates: contradictionCandidates.slice(0, k), orphanCandidates };
    return {
      summary: {
        scanned: rows.length,
        lowValue: report.lowValue.length,
        stale: report.stale.length,
        duplicateClusters: report.duplicateClusters.length,
        contradictionCandidates: report.contradictionCandidates.length,
        orphanCandidates: report.orphanCandidates.length,
      },
      ...report,
    };
  }

  async evaluateMemoryQuality(userId: string, opts: { suite?: string } = {}): Promise<Record<string, unknown>> {
    const contextPack = this.buildContextPack([
      { id: "pref", content: "pref", score: 1, tier: "warm", namespace: "user", project: null, source: "eval", metadata: { memoryType: "user_preference" } },
      { id: "decision", content: "decision", score: 1, tier: "warm", namespace: "decisions", project: null, source: "eval", metadata: { memoryType: "decision" } },
      { id: "setup", content: "setup", score: 1, tier: "warm", namespace: "setup", project: null, source: "eval", metadata: { memoryType: "setup_fact" } },
    ], []);
    const hygiene = await this.hygieneReport(userId, { k: 5 });
    const summary = hygiene.summary as Record<string, number> | undefined;
    const hygieneShapeOk =
      typeof summary?.scanned === "number" &&
      Array.isArray((hygiene as any).lowValue) &&
      Array.isArray((hygiene as any).stale) &&
      Array.isArray((hygiene as any).duplicateClusters) &&
      Array.isArray((hygiene as any).contradictionCandidates) &&
      Array.isArray((hygiene as any).orphanCandidates);
    const cases = [
      {
        name: "newer fact supersedes older fact",
        passed: looksContradictory("NovaMem deployment uses port 7778", "NovaMem deployment uses port 7779"),
      },
      {
        name: "context pack groups typed memories",
        passed: contextPack.userPreferences.length === 1 && contextPack.decisions.length === 1 && contextPack.currentSetup.length === 1,
      },
      { name: "junk capture is rejected", passed: Boolean(this.shouldReject("ok")) },
      { name: "hygiene report exposes review candidates", passed: hygieneShapeOk },
      { name: "memory-type retention policies are available", passed: retentionPolicyFor("deployment_state").policy === "current_only" },
    ];
    const passed = cases.filter((c) => c.passed).length;
    return {
      suite: opts.suite ?? "core",
      passed: passed === cases.length,
      summary: { total: cases.length, passed, failed: cases.length - passed },
      cases,
      checks: cases,
      hygiene,
    };
  }

  /** Drain one bounded batch of entries whose vector was never written.
   *
   *  Deliberately dumb: take the oldest N pending rows, embed, upsert,
   *  stamp. There is no retry counter, no backoff and no dead-letter
   *  state, because the failure this exists for is a *shared* one — the
   *  embedder is either up or it isn't. Per-entry backoff would only
   *  stagger the recovery of entries that will all succeed on the same
   *  tick; when the embedder returns, the backlog drains at batch-size
   *  per interval with no thundering retry. The batch bound is what
   *  keeps a two-day backlog from becoming one enormous request.
   *
   *  Entries that fail keep `embedded_at` NULL and are simply picked up
   *  again next tick, which is the whole point of putting the state on
   *  the row. */
  async reconcilePendingEmbeddings(
    opts: { batchSize?: number } = {},
  ): Promise<{ scanned: number; embedded: number; failed: number; pending: number }> {
    const batchSize = opts.batchSize ?? 50;
    const rows = await this.warm.listPendingEmbedding(batchSize);
    let embedded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const [embedding] = await this.embedder.embed(row.content);
        if (!embedding) {
          failed++;
          continue;
        }
        await this.cold.upsert({
          userId: row.userId,
          projectId: row.projectId,
          id: row.id,
          namespace: row.namespace,
          embedding,
          payload: { source: row.source, agentName: row.agentName },
        });
        await this.warm.setEmbeddedAt(row.id, new Date());
        this.recordEmbedSuccess();
        embedded++;
      } catch (err) {
        failed++;
        this.recordEmbedFailure(err, { entryId: row.id, op: "reconcile" });
      }
    }
    // Count after the batch so the gauge reflects the post-drain backlog;
    // reading it here also keeps health() off the query path.
    const pending = await this.warm.countPendingEmbedding();
    this.pendingEmbeddingsSeen = pending;
    return { scanned: rows.length, embedded, failed, pending };
  }

  /** Backlog as of the last reconciler tick, or null before the first. */
  pendingEmbeddingBacklog(): number | null {
    return this.pendingEmbeddingsSeen;
  }

  async health(): Promise<HealthSnapshot> {
    const [warmOk, coldOk] = await Promise.all([this.warm.ping(), this.cold.ping()]);
    const graphState: HealthSnapshot["deps"]["graph"] = !this.graph
      ? "disabled"
      : this.graph.isConnected()
        ? "ok"
        : "unreachable";
    // The embedder is "failing" only if its most recent outcome was a
    // failure — a single blip that later succeeded is not an outage.
    const embedderState: HealthSnapshot["deps"]["embedder"] =
      this.lastEmbedErrorAt !== null &&
      (this.lastEmbedOkAt === null || this.lastEmbedErrorAt > this.lastEmbedOkAt)
        ? "failing"
        : "ok";
    return {
      // Deliberate asymmetry: a failing embedder and a pending backlog are
      // reported, but neither enters `ok` — and `ok` is what /ready
      // returns. Keyword and graph search still work with a dead embedder,
      // so pulling the whole service out of rotation would convert a
      // partial loss of recall into a total loss of memory for every
      // caller. warm/cold are different: without them there is nothing to
      // serve at all. Alert on `pendingEmbeddings` (also exposed as a
      // metrics gauge); do not gate traffic on it.
      ok: warmOk && coldOk,
      deps: {
        warm: warmOk ? "ok" : "unreachable",
        cold: coldOk ? "ok" : "unreachable",
        graph: graphState,
        embedder: embedderState,
      },
      pendingEmbeddings: this.pendingEmbeddingsSeen,
    };
  }
}

export { effectiveDays, fuse, DEFAULT_WEIGHTS } from "./hybrid-search.js";
