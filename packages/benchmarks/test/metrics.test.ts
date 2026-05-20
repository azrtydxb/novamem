import { describe, expect, it } from "vitest";

import { evaluateRetrieval, normalizeAnswer, tokenF1 } from "../src/metrics.js";

describe("retrieval metrics", () => {
  it("computes recall, precision, MRR, and nDCG at k over multiple queries", () => {
    const result = evaluateRetrieval(
      [
        { queryId: "q1", relevantIds: ["a", "b"], retrievedIds: ["x", "a", "b"] },
        { queryId: "q2", relevantIds: ["c"], retrievedIds: ["c", "d"] },
        { queryId: "q3", relevantIds: ["z"], retrievedIds: ["a", "b"] },
      ],
      [1, 3],
    );

    expect(result.byK[1]?.recall).toBeCloseTo(1 / 3, 6);
    expect(result.byK[1]?.precision).toBeCloseTo(1 / 3, 6);
    expect(result.byK[1]?.mrr).toBeCloseTo((0 + 1 + 0) / 3, 6);
    expect(result.byK[3]?.recall).toBeCloseTo((1 + 1 + 0) / 3, 6);
    expect(result.byK[3]?.precision).toBeCloseTo(((2 / 3) + (1 / 3) + 0) / 3, 6);
    expect(result.byK[3]?.mrr).toBeCloseTo(((1 / 2) + 1 + 0) / 3, 6);
    expect(result.byK[3]?.ndcg).toBeCloseTo(0.5644754678724236, 6);
    expect(result.queryCount).toBe(3);
  });

  it("does not let duplicate retrieved ids inflate recall or nDCG", () => {
    const result = evaluateRetrieval(
      [{ queryId: "q1", relevantIds: ["a"], retrievedIds: ["a", "a", "a"] }],
      [3],
    );

    expect(result.byK[3]?.recall).toBe(1);
    expect(result.byK[3]?.precision).toBeCloseTo(1 / 3, 6);
    expect(result.byK[3]?.ndcg).toBe(1);
  });
});

describe("answer metrics", () => {
  it("normalizes exact answers and computes token F1", () => {
    expect(normalizeAnswer("The Blue, Reef-Mat!")) .toBe("blue reef mat");
    expect(tokenF1("blue reef mat", "the blue reef mat")).toBeCloseTo(1, 6);
    expect(tokenF1("reef mat", "return pump")).toBe(0);
  });
});
