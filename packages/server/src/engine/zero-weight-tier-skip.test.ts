/**
 * A tier weighted 0 contributes 0 to every fused score, so querying it is
 * pure latency. It used to be queried anyway: `{ keyword: 0, vector: 1 }`
 * still paid for the full FTS fan-out across every namespace in scope,
 * and the graph tier still paid GRAPH_SEED_COUNT neighbour walks plus an
 * entity bridge, before both were multiplied by zero.
 *
 * These lock the skip in, because the cost is invisible from the results:
 * the ranking is identical either way, which is exactly why it went
 * unnoticed.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

async function seed(b: ReturnType<typeof makeEngine>) {
  for (const content of [
    "the deploy target is 192.168.10.121",
    "postgres runs on the bench cluster",
    "the user prefers Asia/Dubai for schedules",
  ]) {
    await b.engine.remember("u1", { content, namespace: "default", force: true });
  }
}

describe("zero-weight tiers are not queried", () => {
  it("skips the FTS query when keyword weight is 0", async () => {
    const b = quiet(makeEngine());
    await seed(b);

    let ftsCalls = 0;
    const realFts = b.warm.ftsSearch.bind(b.warm);
    b.warm.ftsSearch = async (args: Parameters<typeof realFts>[0]) => {
      ftsCalls++;
      return realFts(args);
    };

    await b.engine.search("u1", {
      query: "deploy target",
      k: 5,
      weights: { keyword: 0, vector: 1, graph: 0, recency: 0, entity: 0 },
    });
    expect(ftsCalls).toBe(0);

    // ...and is still queried when the weight is non-zero.
    await b.engine.search("u1", {
      query: "deploy target",
      k: 5,
      weights: { keyword: 0.25, vector: 0.75, graph: 0, recency: 0, entity: 0 },
    });
    expect(ftsCalls).toBeGreaterThan(0);
  });

  it("skips graph traversal when graph weight is 0, without marking the search degraded", async () => {
    const b = quiet(makeEngine());
    await seed(b);

    let neighborCalls = 0;
    const realNeighbors = b.graph.neighbors.bind(b.graph);
    b.graph.neighbors = async (...args: Parameters<typeof realNeighbors>) => {
      neighborCalls++;
      return realNeighbors(...args);
    };

    const r = await b.engine.search("u1", {
      query: "deploy target",
      k: 5,
      weights: { keyword: 0.25, vector: 0.75, graph: 0, recency: 0, entity: 0 },
    });
    expect(neighborCalls).toBe(0);
    // Asking for no graph signal is a configuration, not an outage.
    expect(r.degraded).toBe(false);
  });

  it("returns the same ranking with the tiers skipped as with them weighted 0", async () => {
    const b = quiet(makeEngine());
    await seed(b);

    // Weighted 0 but still queried (graph non-zero keeps that tier alive,
    // so only the keyword tier differs between the two calls).
    const withKeywordQueried = await b.engine.search("u1", {
      query: "deploy target",
      k: 5,
      weights: { keyword: 0.0001, vector: 1, graph: 0, recency: 0, entity: 0 },
    });
    const withKeywordSkipped = await b.engine.search("u1", {
      query: "deploy target",
      k: 5,
      weights: { keyword: 0, vector: 1, graph: 0, recency: 0, entity: 0 },
    });
    expect(withKeywordSkipped.results.map((r) => r.id)).toEqual(
      withKeywordQueried.results.map((r) => r.id),
    );
  });
});
