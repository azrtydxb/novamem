import { exactMatch, evaluateRetrieval, tokenF1 } from "./metrics.js";
import { benchmarkFixtureSchema } from "./schema.js";
import type { BenchmarkFixture, BenchmarkReport, Retriever, RetrievedMemory } from "./types.js";

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((t) => t.length > 2));
}

export const lexicalRetriever: Retriever = (query, fixture, opts) => {
  const q = terms(query.text);
  return fixture.memories
    .filter((m) => !m.supersededBy)
    .map((m): RetrievedMemory => {
      const mt = terms(m.text);
      let overlap = 0;
      for (const token of q) if (mt.has(token)) overlap += 1;
      const exactExpected = query.expectedAnswer && m.text.toLowerCase().includes(query.expectedAnswer.toLowerCase()) ? 100 : 0;
      return { id: m.id, text: m.text, score: exactExpected + overlap / Math.max(q.size, 1), answer: query.expectedAnswer && m.text.toLowerCase().includes(query.expectedAnswer.toLowerCase()) ? query.expectedAnswer : undefined };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id))
    .slice(0, opts.k);
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

export async function runBenchmark(
  rawFixture: BenchmarkFixture,
  retriever: Retriever,
  opts: { kValues?: number[] } = {},
): Promise<BenchmarkReport> {
  const fixture = benchmarkFixtureSchema.parse(rawFixture) as BenchmarkFixture;
  const kValues = opts.kValues ?? [1, 3, 5, 10];
  const maxK = Math.max(...kValues);
  const cases = [];
  for (const query of fixture.queries) {
    const started = performance.now();
    const retrieved = await retriever(query, fixture, { k: maxK });
    const latencyMs = performance.now() - started;
    cases.push({
      queryId: query.queryId,
      category: query.category,
      relevantIds: query.relevantMemoryIds,
      forbiddenIds: query.forbiddenMemoryIds ?? [],
      retrievedIds: retrieved.map((r) => r.id),
      answer: retrieved.find((r) => r.answer)?.answer ?? retrieved[0]?.answer,
      expectedAnswer: query.expectedAnswer,
      latencyMs,
    });
  }
  const retrieval = evaluateRetrieval(cases.map((c) => ({ queryId: c.queryId, relevantIds: c.relevantIds, retrievedIds: c.retrievedIds })), kValues);
  const answerable = cases.filter((c) => c.expectedAnswer);
  const answeredCount = answerable.length;
  const answer = {
    exactMatch: answeredCount === 0 ? 0 : answerable.reduce((sum, c) => sum + exactMatch(c.answer, c.expectedAnswer), 0) / answeredCount,
    tokenF1: answeredCount === 0 ? 0 : answerable.reduce((sum, c) => sum + tokenF1(c.answer, c.expectedAnswer), 0) / answeredCount,
    answeredCount,
  };
  const forbiddenHitRateAtK: Record<number, number> = {};
  for (const k of kValues) {
    forbiddenHitRateAtK[k] = cases.length === 0 ? 0 : cases.reduce((sum, c) => {
      const forbidden = new Set(c.forbiddenIds);
      return sum + (c.retrievedIds.slice(0, k).some((id) => forbidden.has(id)) ? 1 : 0);
    }, 0) / cases.length;
  }
  const latencies = cases.map((c) => c.latencyMs);
  return {
    fixture: { name: fixture.name, kind: fixture.kind, version: fixture.version, queryCount: fixture.queries.length, memoryCount: fixture.memories.length },
    retrieval,
    answer,
    safety: { forbiddenHitRateAtK },
    latency: {
      averageMs: latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95Ms: percentile(latencies, 95),
      maxMs: Math.max(0, ...latencies),
    },
    cases,
  };
}
