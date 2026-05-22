/**
 * Hybrid retrieval: combines keyword (FTS), vector cosine, graph-neighbour,
 * recency, and entity-match signals into a single ranked list.
 *
 * Recency and entity are arch-plan Phase 1 additions; older code that only
 * sets {keyword, vector, graph} keeps working — the new signals default to 0
 * and contribute nothing when not provided.
 */

export interface HybridSignal {
  keyword?: number;
  vector?: number;
  graph?: number;
  recency?: number;
  entity?: number;
}

export interface HybridWeights {
  keyword: number;
  vector: number;
  graph: number;
  recency: number;
  entity: number;
}

export const DEFAULT_WEIGHTS: HybridWeights = {
  keyword: 0.25,
  vector: 0.45,
  graph: 0.05,
  recency: 0.10,
  entity: 0.15,
};

export interface HybridInput {
  id: string;
  signals: HybridSignal;
}

export interface HybridOutput {
  id: string;
  score: number;
  signals: { keyword: number; vector: number; graph: number; recency: number; entity: number };
}

/**
 * Combine per-id signal contributions into a single fused score. Each signal
 * is independently min-max normalized within its source so heterogeneous score
 * scales (FTS rank vs cosine vs graph strength vs recency vs entity-match)
 * play nicely.
 */
export function fuse(
  inputs: HybridInput[],
  weightsArg: Partial<HybridWeights> = DEFAULT_WEIGHTS,
): HybridOutput[] {
  // Tolerate callers that pass only a subset of weights (e.g. tests that
  // pre-date Phase 1's recency+entity additions). Missing keys default to
  // 0 so they contribute nothing rather than introducing NaN.
  const weights: HybridWeights = {
    keyword: weightsArg.keyword ?? 0,
    vector: weightsArg.vector ?? 0,
    graph: weightsArg.graph ?? 0,
    recency: weightsArg.recency ?? 0,
    entity: weightsArg.entity ?? 0,
  };
  const max = { keyword: 0, vector: 0, graph: 0, recency: 0, entity: 0 };
  for (const i of inputs) {
    if (i.signals.keyword !== undefined && i.signals.keyword > max.keyword) max.keyword = i.signals.keyword;
    if (i.signals.vector !== undefined && i.signals.vector > max.vector) max.vector = i.signals.vector;
    if (i.signals.graph !== undefined && i.signals.graph > max.graph) max.graph = i.signals.graph;
    if (i.signals.recency !== undefined && i.signals.recency > max.recency) max.recency = i.signals.recency;
    if (i.signals.entity !== undefined && i.signals.entity > max.entity) max.entity = i.signals.entity;
  }
  const norm = (x: number, m: number) => (m > 0 ? x / m : 0);
  type S = { keyword: number; vector: number; graph: number; recency: number; entity: number };
  const grouped = new Map<string, S>();
  for (const i of inputs) {
    const cur: S = grouped.get(i.id) ?? { keyword: 0, vector: 0, graph: 0, recency: 0, entity: 0 };
    if (i.signals.keyword !== undefined) cur.keyword = Math.max(cur.keyword, norm(i.signals.keyword, max.keyword));
    if (i.signals.vector !== undefined) cur.vector = Math.max(cur.vector, norm(i.signals.vector, max.vector));
    if (i.signals.graph !== undefined) cur.graph = Math.max(cur.graph, norm(i.signals.graph, max.graph));
    if (i.signals.recency !== undefined) cur.recency = Math.max(cur.recency, norm(i.signals.recency, max.recency));
    if (i.signals.entity !== undefined) cur.entity = Math.max(cur.entity, norm(i.signals.entity, max.entity));
    grouped.set(i.id, cur);
  }
  const out: HybridOutput[] = [];
  for (const [id, s] of grouped) {
    const score =
      s.keyword * weights.keyword +
      s.vector * weights.vector +
      s.graph * weights.graph +
      s.recency * weights.recency +
      s.entity * weights.entity;
    out.push({ id, score, signals: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Compute a recency signal in [0,1]: exp(-ageDays / halfLifeDays).
 *
 *  Memories with no `updated_at` (rare; legacy) get 0 — they're treated as
 *  arbitrarily old. The signal is min-max normalized across the candidate
 *  set by fuse(), so even "old" memories get a non-trivial share if they're
 *  the freshest in their set. */
export function recencyScore(
  updatedAt: Date | string | null | undefined,
  halfLifeDays = 180,
  asOf: number = Date.now(),
): number {
  if (!updatedAt) return 0;
  const t = typeof updatedAt === "string" ? Date.parse(updatedAt) : updatedAt.getTime();
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (asOf - t) / 86_400_000);
  return Math.exp(-ageDays / halfLifeDays);
}

/** Extract proper-noun-like tokens from a free-text query for entity scoring.
 *
 *  Cheap heuristic (no LLM): captures (a) Capitalised words past sentence
 *  position 0, (b) quoted strings, (c) standalone numbers and dates. Falls
 *  back to single Capitalised words if no multi-word phrases are found.
 *  Returns lowercase tokens for case-insensitive matching downstream. */
export function extractQueryEntities(query: string): string[] {
  const out = new Set<string>();
  // Quoted strings
  for (const m of query.matchAll(/"([^"]+)"/g)) out.add(m[1]!.trim().toLowerCase());
  for (const m of query.matchAll(/'([^']+)'/g)) out.add(m[1]!.trim().toLowerCase());
  // Multi-word Title Case (skip the first sentence word: it's just capitalisation)
  const tokens = query.split(/\s+/);
  let buf: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.replace(/[^A-Za-z0-9-]/g, "");
    const isCapped = /^[A-Z][a-z0-9-]+$/.test(t);
    const isFirstSentence = i === 0;
    if (isCapped && !isFirstSentence) {
      buf.push(t);
    } else {
      if (buf.length >= 1) out.add(buf.join(" ").toLowerCase());
      buf = [];
    }
  }
  if (buf.length >= 1) out.add(buf.join(" ").toLowerCase());
  // Numbers (years, counts, etc.) ≥3 chars
  for (const m of query.matchAll(/\b\d{3,}\b/g)) out.add(m[0]!);
  // Money / units (e.g. $5)
  for (const m of query.matchAll(/\$\d+/g)) out.add(m[0]!);
  return Array.from(out).filter((s) => s.length >= 2);
}

/** Score how strongly a memory's content matches the query's entity set.
 *  Returns the count of distinct query entities present in the content text,
 *  case-insensitive. fuse() min-max normalises this so the actual range
 *  doesn't matter — only the relative ranking. */
export function entityMatchScore(content: string, entities: string[]): number {
  if (!entities.length || !content) return 0;
  const c = content.toLowerCase();
  let hits = 0;
  for (const e of entities) if (c.includes(e)) hits++;
  return hits;
}

/** Synaptic-decay formula. Frequently accessed memories resist demotion.
 *
 *  This JS form must stay in lockstep with the SQL form below — they're
 *  evaluated against the same `hits` column on opposite sides of the
 *  decay loop (engine vs. warm-store) and must agree to the bit, or
 *  promotion and demotion will fight each other. */
export function effectiveDays(hits: number): number {
  return 7 * Math.log2(hits + 1);
}

/** SQL counterpart of `effectiveDays(hits) = 7 * log2(hits + 1)` — kept
 *  next to the JS formula so any future tweak lands on both sides at
 *  once. The decay query parameterises the `7` (base days) so a one-shot
 *  pass can override the schedule; substitute `$n::double precision` for
 *  `$BASE`. The inner expression evaluates to the lifespan in days. */
export const EFFECTIVE_LIFESPAN_SQL =
  "($BASE) * log(2.0, GREATEST(hits, 0) + 1)";
