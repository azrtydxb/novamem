/**
 * Relation enrichment must not sit on the write path, and its debt
 * marker must survive failures. Historically the enrichment stage wrote
 * to FalkorDB (single-threaded; awaiting it capped ingest at ~3.5
 * captures/s) — Phase 7 removed the graph service, so enrichment is now
 * a cold-store neighbour lookup plus SQL relation upserts, still
 * fire-and-forget behind the durable `graph_pending_at` marker.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

describe("async relation enrichment", () => {
  it("returns the write before a slow enrichment finishes", async () => {
    const b = quiet(makeEngine());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let stalled = 0;
    const orig = b.cold.search.bind(b.cold);
    b.cold.search = async (args: Parameters<typeof orig>[0]) => {
      stalled++;
      await gate; // enrichment's neighbour lookup hangs; the write must not
      return orig(args);
    };

    const t0 = Date.now();
    const r = await b.engine.remember("u1", {
      content: "the deploy target kube-vip-bench runs on NodePool7",
      force: true,
    });
    const wallMs = Date.now() - t0;

    expect(r.id).toBeTruthy();
    expect(wallMs).toBeLessThan(1_000);
    release();
    const deadline = Date.now() + 2_000;
    while (stalled === 0 && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 10));
    }
    expect(stalled).toBeGreaterThan(0);
  });

  it("keeps the debt marker when enrichment fails, and the reconciler drains it", async () => {
    const b = quiet(makeEngine());
    // A first entry so the second has a neighbour and enrichment reaches
    // the relation write.
    await b.engine.remember("u1", { content: "alpha alpha alpha", force: true });
    let fail = true;
    const origRel = b.warm.addRelation.bind(b.warm);
    b.warm.addRelation = async (...args: Parameters<typeof origRel>) => {
      if (fail) throw new Error("relations insert failed");
      return origRel(...args);
    };
    const r = await b.engine.remember("u1", { content: "alpha alpha beta", force: true });
    // Wait for the write-time attempt to run and fail — the marker stays.
    const deadline = Date.now() + 2_000;
    while ((await b.warm.countPendingEnrichment()) === 0 && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 10));
    }
    expect(await b.warm.countPendingEnrichment()).toBeGreaterThanOrEqual(1);

    fail = false;
    const rec = await b.engine.reconcilePendingEnrichment({ batchSize: 10 });
    expect(rec.failed).toBe(0);
    expect(rec.pending).toBe(0);
    expect(await b.warm.countPendingEnrichment()).toBe(0);
    // The row is findable regardless — enrichment is an enhancement.
    const s = await b.engine.search("u1", { query: "alpha beta", k: 3 });
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
    for (let i = 0; i < 5; i++) await new Promise((r2) => setImmediate(r2));
    expect(coldSearches).toBe(0);
    expect(await b.warm.countPendingEnrichment()).toBe(0);
  });
});
