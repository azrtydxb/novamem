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

  it("skips enrichment entirely at fanout 0", async () => {
    const b = quiet(makeEngine({ graphLinkFanout: 0 }));
    let entityCalls = 0;
    b.graph.linkEntities = async () => {
      entityCalls++;
    };
    const r = await b.engine.remember("u1", {
      content: "the archive tier retention is 30 days per the ops runbook",
      force: true,
    });
    expect(r.id).toBeTruthy();
    await new Promise((r2) => setTimeout(r2, 100));
    expect(entityCalls).toBe(0);
  });
});
