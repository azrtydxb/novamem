import type { RetrievalCase, RetrievalReport } from "./types.js";

export function normalizeAnswer(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenF1(predicted: string | undefined, expected: string | undefined): number {
  if (!predicted || !expected) return 0;
  const p = normalizeAnswer(predicted).split(" ").filter(Boolean);
  const e = normalizeAnswer(expected).split(" ").filter(Boolean);
  if (p.length === 0 || e.length === 0) return p.length === e.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const token of e) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of p) {
    const n = counts.get(token) ?? 0;
    if (n > 0) {
      overlap += 1;
      counts.set(token, n - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / p.length;
  const recall = overlap / e.length;
  return (2 * precision * recall) / (precision + recall);
}

function dcg(binaryRelevance: number[]): number {
  return binaryRelevance.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

function evaluateAtK(cases: RetrievalCase[], k: number) {
  const totals = { recall: 0, precision: 0, mrr: 0, ndcg: 0 };
  for (const c of cases) {
    const relevant = new Set(c.relevantIds);
    const top = c.retrievedIds.slice(0, k);
    const gains: number[] = [];
    const seenRelevant = new Set<string>();
    for (const id of top) {
      if (relevant.has(id) && !seenRelevant.has(id)) {
        seenRelevant.add(id);
        gains.push(1);
      } else {
        gains.push(0);
      }
    }
    const hits = seenRelevant.size;
    totals.recall += relevant.size === 0 ? 1 : hits / relevant.size;
    totals.precision += k === 0 ? 0 : hits / k;
    const firstHit = gains.findIndex((rel) => rel === 1);
    totals.mrr += firstHit === -1 ? 0 : 1 / (firstHit + 1);
    const idealHits = Math.min(relevant.size, k);
    const ideal = Array.from({ length: k }, (_, i) => (i < idealHits ? 1 : 0));
    const idealDcg = dcg(ideal);
    totals.ndcg += idealDcg === 0 ? 1 : dcg(gains) / idealDcg;
  }
  const n = Math.max(cases.length, 1);
  return {
    recall: totals.recall / n,
    precision: totals.precision / n,
    mrr: totals.mrr / n,
    ndcg: totals.ndcg / n,
  };
}

export function evaluateRetrieval(cases: RetrievalCase[], kValues: number[] = [1, 3, 5, 10]): RetrievalReport {
  const byK: RetrievalReport["byK"] = {};
  for (const k of kValues) byK[k] = evaluateAtK(cases, k);
  return { queryCount: cases.length, byK };
}

export function exactMatch(predicted: string | undefined, expected: string | undefined): number {
  if (!predicted || !expected) return 0;
  return normalizeAnswer(predicted) === normalizeAnswer(expected) ? 1 : 0;
}
