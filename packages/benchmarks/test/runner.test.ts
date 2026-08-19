import { describe, expect, it } from "vitest";

import { lexicalRetriever, runBenchmark } from "../src/runner.js";

describe("benchmark runner", () => {
  it("runs a fixture with a retriever and reports retrieval, answer, forbidden, and latency metrics", async () => {
    const report = await runBenchmark(
      {
        name: "smoke",
        kind: "novamem-specific",
        version: "1",
        memories: [
          {
            id: "m1",
            text: "Pascal's reef tank uses ReefMat 1200 fleece.",
            metadata: { memoryType: "setup_fact" },
          },
          {
            id: "m2",
            text: "Pascal's reef tank uses filter socks.",
            supersededBy: "m1",
          },
        ],
        queries: [
          {
            queryId: "q1",
            text: "Which fleece roller does Pascal's reef tank use?",
            expectedAnswer: "ReefMat 1200",
            relevantMemoryIds: ["m1"],
            forbiddenMemoryIds: ["m2"],
            category: "preference-recall",
          },
        ],
      },
      lexicalRetriever,
      { kValues: [1, 5] }
    );

    expect(report.fixture.name).toBe("smoke");
    expect(report.retrieval.byK[1]?.recall).toBe(1);
    expect(report.answer.exactMatch).toBe(1);
    expect(report.safety.forbiddenHitRateAtK[5]).toBe(0);
    expect(report.latency.averageMs).toBeGreaterThanOrEqual(0);
    expect(report.cases[0]?.retrievedIds[0]).toBe("m1");
  });
});
