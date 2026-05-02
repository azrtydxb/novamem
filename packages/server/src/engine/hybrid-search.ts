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

export interface HybridInput {
  id: string;
  signals: HybridSignal;
}

export interface HybridOutput {
  id: string;
  score: number;
  signals: { keyword: number; vector: number; graph: number };
}

/**
 * Combine per-id signal contributions into a single fused score. Each signal
 * is independently min-max normalized within its source so heterogeneous score
 * scales (FTS rank vs cosine vs graph strength) play nicely.
 */
export function fuse(
  inputs: HybridInput[],
  weights: HybridWeights = DEFAULT_WEIGHTS,
): HybridOutput[] {
  const max = { keyword: 0, vector: 0, graph: 0 };
  for (const i of inputs) {
    if (i.signals.keyword !== undefined && i.signals.keyword > max.keyword) max.keyword = i.signals.keyword;
    if (i.signals.vector !== undefined && i.signals.vector > max.vector) max.vector = i.signals.vector;
    if (i.signals.graph !== undefined && i.signals.graph > max.graph) max.graph = i.signals.graph;
  }
  const norm = (x: number, m: number) => (m > 0 ? x / m : 0);
  const grouped = new Map<string, { keyword: number; vector: number; graph: number }>();
  for (const i of inputs) {
    const cur = grouped.get(i.id) ?? { keyword: 0, vector: 0, graph: 0 };
    if (i.signals.keyword !== undefined) cur.keyword = Math.max(cur.keyword, norm(i.signals.keyword, max.keyword));
    if (i.signals.vector !== undefined) cur.vector = Math.max(cur.vector, norm(i.signals.vector, max.vector));
    if (i.signals.graph !== undefined) cur.graph = Math.max(cur.graph, norm(i.signals.graph, max.graph));
    grouped.set(i.id, cur);
  }
  const out: HybridOutput[] = [];
  for (const [id, s] of grouped) {
    const score = s.keyword * weights.keyword + s.vector * weights.vector + s.graph * weights.graph;
    out.push({ id, score, signals: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Synaptic-decay formula. Frequently accessed memories resist demotion. */
export function effectiveDays(hits: number): number {
  return 7 * Math.log2(hits + 1);
}
