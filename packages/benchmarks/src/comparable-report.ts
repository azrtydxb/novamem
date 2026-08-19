import { exactMatch, tokenF1 } from "./metrics.js";
import type { BenchmarkReport, BenchmarkKind } from "./types.js";

export interface ComparableReportOptions {
  projectName: string;
  runId?: string;
  timestamp?: string;
  mode?: "answerer" | "predict";
  answererModel?: string;
  judgeModel?: string;
  provider?: string;
  topKCutoffs?: number[];
}

export interface ComparableScoreBucket {
  total: number;
  correct: number;
  accuracy: number;
  avg_score: number;
}

export interface ComparableMemoryBenchmarkReport {
  metadata: {
    benchmark: BenchmarkKind;
    project_name: string;
    run_id: string;
    timestamp: string;
    mode: string;
    answerer_model: string;
    judge_model: string;
    provider: string;
    top_k: number;
    top_k_cutoffs: string[];
    total_questions: number;
    question_types: string[];
  };
  metrics_by_cutoff: Record<
    string,
    {
      overall: ComparableScoreBucket;
      by_question_type: Record<string, ComparableScoreBucket>;
    }
  >;
  evaluations: Array<{
    question_id: string;
    question_type: string;
    question: string;
    ground_truth_answer?: string;
    generated_answer?: string;
    score: number;
    correct: boolean;
    retrieval: {
      search_results: Array<{
        id: string;
        rank: number;
        relevant: boolean;
        forbidden: boolean;
      }>;
    };
    latency_ms: number;
  }>;
  diagnostics: {
    retrieval: BenchmarkReport["retrieval"];
    safety: BenchmarkReport["safety"];
    latency: BenchmarkReport["latency"];
  };
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function bucket(total: number, correct: number): ComparableScoreBucket {
  const accuracy = percent(correct, total);
  return { total, correct, accuracy, avg_score: accuracy };
}

function uniqueSortedCategories(report: BenchmarkReport): string[] {
  return [...new Set(report.cases.map((c) => c.category ?? "unknown"))].sort();
}

function isCorrectAtCutoff(
  testCase: BenchmarkReport["cases"][number],
  k: number
): boolean {
  if (!testCase.expectedAnswer) return false;
  if (
    exactMatch(testCase.answer, testCase.expectedAnswer) !== 1 &&
    tokenF1(testCase.answer, testCase.expectedAnswer) < 0.999
  )
    return false;
  const relevant = new Set(testCase.relevantIds);
  const forbidden = new Set(testCase.forbiddenIds);
  const top = testCase.retrievedIds.slice(0, k);
  return (
    top.some((id) => relevant.has(id)) && !top.some((id) => forbidden.has(id))
  );
}

function summarizeCutoff(
  report: BenchmarkReport,
  k: number,
  categories: string[]
) {
  const overallCorrect = report.cases.reduce(
    (sum, c) => sum + (isCorrectAtCutoff(c, k) ? 1 : 0),
    0
  );
  const by_question_type: Record<string, ComparableScoreBucket> = {};
  for (const category of categories) {
    const cases = report.cases.filter(
      (c) => (c.category ?? "unknown") === category
    );
    const correct = cases.reduce(
      (sum, c) => sum + (isCorrectAtCutoff(c, k) ? 1 : 0),
      0
    );
    by_question_type[category] = bucket(cases.length, correct);
  }
  return {
    overall: bucket(report.cases.length, overallCorrect),
    by_question_type,
  };
}

export function toComparableMemoryBenchmarkReport(
  report: BenchmarkReport,
  opts: ComparableReportOptions
): ComparableMemoryBenchmarkReport {
  const topKCutoffs = opts.topKCutoffs ?? [10, 20, 50, 200];
  const categories = uniqueSortedCategories(report);
  const metrics_by_cutoff: ComparableMemoryBenchmarkReport["metrics_by_cutoff"] =
    {};
  for (const k of topKCutoffs)
    metrics_by_cutoff[`top_${k}`] = summarizeCutoff(report, k, categories);

  return {
    metadata: {
      benchmark: report.fixture.kind,
      project_name: opts.projectName,
      run_id: opts.runId ?? `${report.fixture.name}-${Date.now().toString(36)}`,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      mode: opts.mode ?? "answerer",
      answerer_model: opts.answererModel ?? "unknown",
      judge_model: opts.judgeModel ?? "exact-match-token-f1",
      provider: opts.provider ?? "novamem",
      top_k: Math.max(...topKCutoffs),
      top_k_cutoffs: topKCutoffs.map((k) => `top_${k}`),
      total_questions: report.cases.length,
      question_types: categories,
    },
    metrics_by_cutoff,
    evaluations: report.cases.map((c) => {
      const score = c.expectedAnswer
        ? Math.max(
            exactMatch(c.answer, c.expectedAnswer),
            tokenF1(c.answer, c.expectedAnswer)
          ) * 100
        : 0;
      const correct = isCorrectAtCutoff(c, Math.max(...topKCutoffs));
      const relevant = new Set(c.relevantIds);
      const forbidden = new Set(c.forbiddenIds);
      return {
        question_id: c.queryId,
        question_type: c.category ?? "unknown",
        question: c.queryId,
        ground_truth_answer: c.expectedAnswer,
        generated_answer: c.answer,
        score,
        correct,
        retrieval: {
          search_results: c.retrievedIds.map((id, index) => ({
            id,
            rank: index + 1,
            relevant: relevant.has(id),
            forbidden: forbidden.has(id),
          })),
        },
        latency_ms: c.latencyMs,
      };
    }),
    diagnostics: {
      retrieval: report.retrieval,
      safety: report.safety,
      latency: report.latency,
    },
  };
}
