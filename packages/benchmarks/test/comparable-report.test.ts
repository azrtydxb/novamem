import { describe, expect, it } from "vitest";

import { toComparableMemoryBenchmarkReport } from "../src/comparable-report.js";
import type { BenchmarkReport } from "../src/types.js";

describe("comparable memory benchmark report", () => {
  it("emits LongMemEval/Mem0-compatible metrics_by_cutoff with overall and per-question-type accuracy", () => {
    const report: BenchmarkReport = {
      fixture: {
        name: "longmemeval-smoke",
        kind: "longmemeval",
        version: "1",
        queryCount: 3,
        memoryCount: 6,
      },
      retrieval: {
        queryCount: 3,
        byK: {
          10: { recall: 2 / 3, precision: 0, mrr: 0, ndcg: 0 },
          20: { recall: 2 / 3, precision: 0, mrr: 0, ndcg: 0 },
          50: { recall: 1, precision: 0, mrr: 0, ndcg: 0 },
          200: { recall: 1, precision: 0, mrr: 0, ndcg: 0 },
        },
      },
      answer: { exactMatch: 0, tokenF1: 0, answeredCount: 3 },
      safety: { forbiddenHitRateAtK: { 10: 0, 20: 0, 50: 0, 200: 0 } },
      latency: { averageMs: 12, p95Ms: 20, maxMs: 22 },
      cases: [
        {
          queryId: "q1",
          category: "single-session-user",
          relevantIds: ["m1"],
          forbiddenIds: [],
          retrievedIds: ["m1"],
          answer: "Business Administration",
          expectedAnswer: "Business Administration",
          latencyMs: 10,
        },
        {
          queryId: "q2",
          category: "knowledge-update",
          relevantIds: ["m2"],
          forbiddenIds: ["old-m2"],
          retrievedIds: ["old-m2", "m2"],
          answer: "filter socks",
          expectedAnswer: "ReefMat 1200",
          latencyMs: 20,
        },
        {
          queryId: "q3",
          category: "knowledge-update",
          relevantIds: ["m3"],
          forbiddenIds: [],
          retrievedIds: [],
          answer: undefined,
          expectedAnswer: "Dubai",
          latencyMs: 22,
        },
      ],
    };

    const comparable = toComparableMemoryBenchmarkReport(report, {
      projectName: "novamem-live",
      runId: "abc123",
      answererModel: "qwen3.6",
      judgeModel: "exact-match",
      provider: "novamem",
      topKCutoffs: [10, 20, 50, 200],
    });

    expect(comparable.metadata).toMatchObject({
      benchmark: "longmemeval",
      project_name: "novamem-live",
      run_id: "abc123",
      mode: "answerer",
      answerer_model: "qwen3.6",
      judge_model: "exact-match",
      provider: "novamem",
      top_k: 200,
      top_k_cutoffs: ["top_10", "top_20", "top_50", "top_200"],
      total_questions: 3,
      question_types: ["knowledge-update", "single-session-user"],
    });

    expect(comparable.metrics_by_cutoff.top_10.overall).toEqual({
      total: 3,
      correct: 1,
      accuracy: 33.33333333333333,
      avg_score: 33.33333333333333,
    });
    expect(comparable.metrics_by_cutoff.top_50.overall.correct).toBe(1);
    expect(
      comparable.metrics_by_cutoff.top_10.by_question_type["knowledge-update"]
    ).toEqual({
      total: 2,
      correct: 0,
      accuracy: 0,
      avg_score: 0,
    });
    expect(
      comparable.metrics_by_cutoff.top_10.by_question_type[
        "single-session-user"
      ].accuracy
    ).toBe(100);
    expect(comparable.evaluations).toHaveLength(3);
    expect(comparable.evaluations[0]).toMatchObject({
      question_id: "q1",
      question_type: "single-session-user",
      ground_truth_answer: "Business Administration",
      generated_answer: "Business Administration",
      score: 100,
      correct: true,
    });
  });
});
