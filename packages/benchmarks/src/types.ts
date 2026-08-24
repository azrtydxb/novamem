export type BenchmarkKind =
  | "longmemeval"
  | "locomo"
  | "beir"
  | "rag"
  | "long-context"
  | "novamem-specific";

export interface BenchmarkMemory {
  id: string;
  text: string;
  timestamp?: string;
  sessionId?: string;
  supersededBy?: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkQuery {
  queryId: string;
  text: string;
  expectedAnswer?: string;
  relevantMemoryIds: string[];
  forbiddenMemoryIds?: string[];
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkFixture {
  name: string;
  kind: BenchmarkKind;
  version: string;
  description?: string;
  source?: {
    name: string;
    url?: string;
    license?: string;
    notes?: string;
  };
  memories: BenchmarkMemory[];
  queries: BenchmarkQuery[];
}

export interface RetrievedMemory {
  id: string;
  text?: string;
  score?: number;
  answer?: string;
  metadata?: Record<string, unknown>;
}

export type Retriever = (
  query: BenchmarkQuery,
  fixture: BenchmarkFixture,
  opts: { k: number }
) => Promise<RetrievedMemory[]> | RetrievedMemory[];

export interface RetrievalCase {
  queryId: string;
  relevantIds: string[];
  retrievedIds: string[];
}

export interface RetrievalAtK {
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
}

export interface RetrievalReport {
  queryCount: number;
  byK: Record<number, RetrievalAtK>;
}

export interface BenchmarkCaseReport {
  queryId: string;
  category?: string;
  relevantIds: string[];
  forbiddenIds: string[];
  retrievedIds: string[];
  answer?: string;
  expectedAnswer?: string;
  latencyMs: number;
}

export interface BenchmarkReport {
  fixture: {
    name: string;
    kind: BenchmarkKind;
    version: string;
    queryCount: number;
    memoryCount: number;
  };
  retrieval: RetrievalReport;
  answer: { exactMatch: number; tokenF1: number; answeredCount: number };
  safety: { forbiddenHitRateAtK: Record<number, number> };
  latency: { averageMs: number; p95Ms: number; maxMs: number };
  cases: BenchmarkCaseReport[];
}
