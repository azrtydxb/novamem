/**
 * Graph enrichment must not sit on the write path. FalkorDB is
 * single-threaded, so when the two enrichment queries were awaited,
 * every concurrent writer queued behind one graph thread — profiled at
 * ~179 ms mean per query during a bulk load, it capped ingest at ~3.5
 * captures/s regardless of client concurrency.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

describe("async graph enrichment", () => {
  it("returns the write before a slow graph finishes enrichment", async () => {
    const b = quiet(makeEngine());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entityCalls = 0;
    b.graph.linkEntities = async () => {
      entityCalls++;
      await gate; // a graph stall must not stall the caller
    };

    const t0 = Date.now();
    const r = await b.engine.remember("u1", {
      content: "the deploy target kube-vip-bench runs on NodePool7",
      force: true,
    });
    const wallMs = Date.now() - t0;

    expect(r.id).toBeTruthy();
    expect(wallMs).toBeLessThan(1_000); // write returned while graph hangs
    release();
    // Enrichment still ran in the background — poll, don't sleep-and-hope.
    const deadline = Date.now() + 2_000;
    while (entityCalls === 0 && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 10));
    }
    expect(entityCalls).toBe(1);
  });

  it("keeps the debt marker when enrichment fails, and the reconciler drains it", async () => {
    const b = quiet(makeEngine());
    let fail = true;
    let entityCalls = 0;
    b.graph.linkEntities = async () => {
      entityCalls++;
      if (fail) throw new Error("falkordb down");
    };
    const r = await b.engine.remember("u1", {
      content: "the deploy target kube-vip-bench runs on NodePool7",
      force: true,
    });
    // Wait for the write-time attempt to fail.
    const deadline = Date.now() + 2_000;
    while (entityCalls === 0 && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 10));
    }
    expect(await b.warm.countPendingEnrichment()).toBe(1);

    fail = false;
    const rec = await b.engine.reconcilePendingEnrichment({ batchSize: 10 });
    expect(rec.enriched).toBe(1);
    expect(rec.pending).toBe(0);
    expect(await b.warm.countPendingEnrichment()).toBe(0);
    // The row is findable regardless — enrichment is an enhancement.
    const s = await b.engine.search("u1", { query: "kube-vip-bench deploy target", k: 3 });
    expect(s.results.some((x) => x.id === r.id)).toBe(true);
  });

  it("clears the debt marker after a successful write-time attempt", async () => {
    const b = quiet(makeEngine());
    await b.engine.remember("u1", {
      content: "the deploy target kube-vip-bench runs on NodePool7",
      force: true,
    });
    const deadline = Date.now() + 2_000;
    while ((await b.warm.countPendingEnrichment()) > 0 && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 10));
    }
    expect(await b.warm.countPendingEnrichment()).toBe(0);
  });

  it("skips enrichment entirely at fanout 0", async () => {
    const b = quiet(makeEngine({ graphLinkFanout: 0 }));
    // Spy on the enrichment ENTRYPOINT: linkVectorNeighbors always begins
    // with a cold.search, whereas linkEntities is conditional on entity
    // extraction — asserting on it could false-pass.
    let coldSearches = 0;
    const orig = b.cold.search.bind(b.cold);
    b.cold.search = async (args: Parameters<typeof orig>[0]) => {
      coldSearches++;
      return orig(args);
    };
    const r = await b.engine.remember("u1", {
      content: "the archive tier retention is 30 days per the ops runbook",
      force: true,
    });
    expect(r.id).toBeTruthy();
    // Yield a few macrotasks instead of a fixed sleep.
    for (let i = 0; i < 5; i++) await new Promise((r2) => setImmediate(r2));
    expect(coldSearches).toBe(0);
    // And the write owes no enrichment debt at fanout 0.
    expect(await b.warm.countPendingEnrichment()).toBe(0);
  });
});
