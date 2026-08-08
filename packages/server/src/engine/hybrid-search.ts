/**
 * Hybrid retrieval: combines keyword (FTS), vector cosine, and graph-neighbour
 * signals into a single ranked list. Weights match NovaFlow's pre-extraction
 * defaults; callers may override per-request.
 */

export interface HybridSignal {
  keyword?: number;
  vector?: number;
  graph?: number;
}

export interface HybridWeights {
  keyword: number;
  vector: number;
  graph: number;
}

export const DEFAULT_WEIGHTS: HybridWeights = {
  keyword: 0.3,
  vector: 0.6,
  graph: 0.1,
};

/** Candidates whose *only* evidence is a weak vector neighbour are noise:
 *  cosine similarity always returns a nearest neighbour, even when nothing
 *  in the store is related to the query. Anything at or below this cosine
 *  with no keyword/graph corroboration is dropped rather than surfaced with
 *  a confident-looking fused score. Overridable per call (and via
 *  NOVAMEM_SEARCH_MIN_VECTOR_SCORE) because the right value depends on the
 *  embedding model's similarity distribution. */
export const DEFAULT_MIN_VECTOR_SCORE = 0.25;

export interface HybridInput {
  id: string;
  signals: HybridSignal;
}

export interface HybridOutput {
  id: string;
  score: number;
  signals: { keyword: number; vector: number; graph: number };
}

export interface FuseOptions {
  /** Absolute cosine floor for vector-only candidates. Defaults to
   *  DEFAULT_MIN_VECTOR_SCORE; pass 0 to disable the filter. */
  minVectorScore?: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Combine per-id signal contributions into a single fused score.
 *
 * Scale handling is deliberately asymmetric, because the three signals are
 * not the same kind of number:
 *
 *   - **vector** is a cosine similarity. It already has an absolute,
 *     model-independent meaning ("0.83 similar"), so it is used raw
 *     (clamped to [0,1]). Normalising it per query — as this function used
 *     to — destroyed exactly that meaning: the best hit always became 1.0
 *     even when the best cosine in the store was 0.28, so a query with no
 *     relevant memories still produced a top result with a high fused
 *     score. That made the documented "a top score below ~0.4 is a miss"
 *     heuristic (see mcp-instructions.ts / SKILL.md) impossible to apply.
 *   - **keyword** is `ts_rank`, which has no absolute scale at all — its
 *     magnitude depends on document length and term frequency in the
 *     corpus. It is therefore max-normalised within the query, which is
 *     the only defensible reading of it.
 *   - **graph** is an edge strength that was a cosine at write time, so
 *     it is used raw like the vector signal.
 *
 * Weights are renormalised across the tiers that actually produced
 * candidates. Without that, a query where the keyword tier returned
 * nothing would cap every result at 0.7 (the vector+graph weight), and the
 * absolute threshold above would silently mean something different
 * depending on which tiers happened to be alive.
 */
export function fuse(
  inputs: HybridInput[],
  weights: HybridWeights = DEFAULT_WEIGHTS,
  opts: FuseOptions = {},
): HybridOutput[] {
  const minVectorScore = opts.minVectorScore ?? DEFAULT_MIN_VECTOR_SCORE;

  // `ts_rank` has no absolute scale — normalise it within the query.
  let maxKeyword = 0;
  const present = { keyword: false, vector: false, graph: false };
  for (const i of inputs) {
    if (i.signals.keyword !== undefined) {
      present.keyword = true;
      if (i.signals.keyword > maxKeyword) maxKeyword = i.signals.keyword;
    }
    if (i.signals.vector !== undefined) present.vector = true;
    if (i.signals.graph !== undefined) present.graph = true;
  }

  // Redistribute the weight of tiers that produced no candidates so the
  // fused score stays on a stable [0,1] scale regardless of which tiers
  // ran. When nothing at all came back the weights are irrelevant (the
  // output is empty), so any non-zero fallback is fine.
  const activeTotal =
    (present.keyword ? weights.keyword : 0) +
    (present.vector ? weights.vector : 0) +
    (present.graph ? weights.graph : 0);
  const w =
    activeTotal > 0
      ? {
          keyword: present.keyword ? weights.keyword / activeTotal : 0,
          vector: present.vector ? weights.vector / activeTotal : 0,
          graph: present.graph ? weights.graph / activeTotal : 0,
        }
      : { keyword: 0, vector: 0, graph: 0 };

  const grouped = new Map<
    string,
    { keyword: number; vector: number; graph: number; hasKeyword: boolean; hasGraph: boolean }
  >();
  for (const i of inputs) {
    const cur =
      grouped.get(i.id) ?? { keyword: 0, vector: 0, graph: 0, hasKeyword: false, hasGraph: false };
    if (i.signals.keyword !== undefined) {
      cur.hasKeyword = true;
      const normalized = maxKeyword > 0 ? clamp01(i.signals.keyword / maxKeyword) : 0;
      cur.keyword = Math.max(cur.keyword, normalized);
    }
    if (i.signals.vector !== undefined) {
      cur.vector = Math.max(cur.vector, clamp01(i.signals.vector));
    }
    if (i.signals.graph !== undefined) {
      cur.hasGraph = true;
      cur.graph = Math.max(cur.graph, clamp01(i.signals.graph));
    }
    grouped.set(i.id, cur);
  }

  const out: HybridOutput[] = [];
  for (const [id, s] of grouped) {
    // Noise floor: a candidate that only the vector tier proposed, at a
    // cosine this low, is the nearest of an unrelated set — not a hit.
    if (!s.hasKeyword && !s.hasGraph && s.vector < minVectorScore) continue;
    const score = s.keyword * w.keyword + s.vector * w.vector + s.graph * w.graph;
    out.push({ id, score, signals: { keyword: s.keyword, vector: s.vector, graph: s.graph } });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Multiplicative rank-time prior applied on top of the fused similarity
 *  score. Similarity alone is blind to two things the store already
 *  records: how sure we were when we wrote the memory (`confidence`), and
 *  how stale it is for memory types whose whole point is being current
 *  (`deployment_state`, `setup_fact`). Without this a six-month-old
 *  deployment fact outranks last week's correction whenever its phrasing
 *  happens to sit closer to the query.
 *
 *  Deliberately gentle — it re-orders near-ties, it does not overturn a
 *  clear similarity win. Bounded to [0.7, 1.15]. */
export function rankPrior(args: {
  confidence?: number | null;
  memoryType?: string | null;
  ageDays?: number | null;
}): number {
  const confidence = typeof args.confidence === "number" && Number.isFinite(args.confidence)
    ? clamp01(args.confidence)
    : 1;
  const confidenceFactor = 0.7 + 0.3 * confidence;

  // Only "current state" memory types get a recency boost. A user
  // preference or a safety constraint doesn't become less true with age,
  // so boosting recent ones would just add noise.
  const RECENCY_SENSITIVE = new Set(["deployment_state", "setup_fact"]);
  let recencyFactor = 1;
  if (args.memoryType && RECENCY_SENSITIVE.has(args.memoryType)) {
    const ageDays = typeof args.ageDays === "number" && Number.isFinite(args.ageDays)
      ? Math.max(0, args.ageDays)
      : null;
    if (ageDays !== null) recencyFactor = 1 + 0.15 * Math.exp(-ageDays / 30);
  }
  return confidenceFactor * recencyFactor;
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
