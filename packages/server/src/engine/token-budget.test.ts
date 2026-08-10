/**
 * `k` bounds how many results come back, which is not the thing a caller
 * needs to control. Measured on a LongMemEval slice, the same `k=10` cost
 * ~500 tokens against a fact-bearing corpus and ~7,500 against raw
 * conversation chunks — a 15x spread from one parameter that looks fixed.
 *
 * Budgeting in tokens is what lets the compact representation pay off: on
 * that slice, facts reached the same answer accuracy as raw chunks on
 * roughly a quarter of the tokens.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";
import { estimateTokens } from "./index.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

/** ~250 tokens each, distinct enough to survive the diversity filter. */
function longMemory(i: number): string {
  return `memory ${i} about deployment topic ${i}: ` + `detail-${i} `.repeat(140);
}

describe("token-budgeted retrieval", () => {
  it("stops admitting results once the budget is spent", async () => {
    const b = quiet(makeEngine());
    for (let i = 0; i < 8; i++) {
      await b.engine.remember("u1", { content: longMemory(i), force: true });
    }

    const unbounded = await b.engine.search("u1", { query: "deployment topic", k: 8 });
    const budgeted = await b.engine.search("u1", { query: "deployment topic", k: 8, maxTokens: 600 });

    expect(unbounded.results.length).toBeGreaterThan(budgeted.results.length);
    const spent = budgeted.results.reduce((n, r) => n + estimateTokens(r.content), 0);
    // One result may straddle the limit (see the first-result rule below),
    // so allow the last admitted item to overshoot.
    const last = estimateTokens(budgeted.results.at(-1)?.content ?? "");
    expect(spent - last).toBeLessThanOrEqual(600);
  });

  it("always returns the top hit, even when it alone exceeds the budget", async () => {
    const b = quiet(makeEngine());
    await b.engine.remember("u1", { content: longMemory(1), force: true });
    const r = await b.engine.search("u1", { query: "deployment topic", k: 5, maxTokens: 1 });
    expect(r.results.length).toBe(1);
  });

  it("leaves behaviour unchanged when no budget is given", async () => {
    const b = quiet(makeEngine());
    for (let i = 0; i < 5; i++) {
      await b.engine.remember("u1", { content: longMemory(i), force: true });
    }
    const r = await b.engine.search("u1", { query: "deployment topic", k: 5 });
    expect(r.results.length).toBe(5);
  });
});
