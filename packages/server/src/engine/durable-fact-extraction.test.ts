/**
 * Phase 1 of the Mem0 alignment (docs/architecture/mem0-alignment.md):
 * fact extraction must survive a restart.
 *
 * Before this queue existed, extraction was a `void`-scheduled promise
 * with no durable record. A pod restart, deploy or OOM while extractions
 * were in flight dropped them permanently — measured at 10,446 chunks'
 * facts in a single mid-drain rollout — with nothing recording that they
 * were owed. Embeddings never had this problem, because `embedded_at`
 * IS the queue; this is its extraction twin (`facts_pending_at`,
 * polarity inverted — see the schema comment for why).
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

/** Extractor stub with a switchable outage, mirroring "the LLM endpoint
 *  is up or it isn't" — the shared failure the reconciler exists for. */
function flakyExtractor() {
  const state = { fail: false, calls: 0 };
  return {
    state,
    async extract(content: string) {
      state.calls += 1;
      if (state.fail) throw new Error("extraction endpoint down");
      if (content.includes("nothing durable")) return [];
      return [
        {
          type: "preference",
          subject: "the user",
          predicate: "prefers",
          object: "oat milk in coffee",
          entities: [],
          importance: 3,
        },
      ];
    },
  };
}

/** Fire-and-forget extraction exposes no handle to await, so poll for
 *  the side effect. A fixed sleep is either flaky on a loaded runner or
 *  slow on every run. */
async function until(cond: () => Promise<boolean> | boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("durable fact-extraction queue", () => {
  it("marks the chunk pending at insert and clears it when extraction lands", async () => {
    const ex = flakyExtractor();
    const b = quiet(makeEngine({ extractor: ex }));
    const r = await b.engine.remember("u1", { content: "user: I take oat milk in my coffee", force: true });
    // The marker is written with the row, before the background pass runs.
    // (It may already be cleared if the void chain won the race, so assert
    // the end state rather than the transient.)
    await until(async () => (await b.warm.countPendingFacts()) === 0);
    expect(b.warm.rows.get(r.id!)?.factsPendingAt).toBeNull();
    expect(await b.warm.countPendingFacts()).toBe(0);
    expect([...b.warm.rows.values()].some((x) => x.sourceType === "fact")).toBe(true);
  });

  it("keeps the debt on the row when the extractor is down", async () => {
    const ex = flakyExtractor();
    ex.state.fail = true;
    const b = quiet(makeEngine({ extractor: ex }));
    const r = await b.engine.remember("u1", { content: "user: I take oat milk in my coffee", force: true });
    // The failing extraction has fired (calls advanced) yet the debt
    // remains — that pair is the durable-queue invariant.
    await until(() => ex.state.calls >= 1);
    expect(b.warm.rows.get(r.id!)?.factsPendingAt).not.toBeNull();
    expect(await b.warm.countPendingFacts()).toBe(1);
  });

  it("reconciler drains the backlog once the extractor returns", async () => {
    const ex = flakyExtractor();
    ex.state.fail = true;
    const b = quiet(makeEngine({ extractor: ex }));
    await b.engine.remember("u1", { content: "user: I take oat milk in my coffee", force: true });
    await b.engine.remember("u1", { content: "user: my 5K personal best is 25:50", force: true });
    await until(() => ex.state.calls >= 2);
    expect(await b.warm.countPendingFacts()).toBe(2);

    // Outage ends. Nothing re-triggers the lost extractions except the
    // reconciler — that is the entire point of the queue.
    ex.state.fail = false;
    const r = await b.engine.reconcilePendingFacts({ batchSize: 50 });
    expect(r.scanned).toBe(2);
    expect(r.extracted).toBe(2);
    expect(r.pending).toBe(0);
    expect([...b.warm.rows.values()].filter((x) => x.sourceType === "fact").length).toBeGreaterThan(0);
  });

  it("a zero-fact chunk is a completed extraction, not a permanent retry", async () => {
    const ex = flakyExtractor();
    const b = quiet(makeEngine({ extractor: ex }));
    await b.engine.remember("u1", { content: "user: nothing durable here, just chit-chat", force: true });
    await until(async () => (await b.warm.countPendingFacts()) === 0);
    expect(await b.warm.countPendingFacts()).toBe(0);
    const calls = ex.state.calls;
    const r = await b.engine.reconcilePendingFacts({ batchSize: 50 });
    expect(r.scanned).toBe(0);
    expect(ex.state.calls).toBe(calls); // no re-extraction of settled chunks
  });

  it("fact rows themselves never enter the queue", async () => {
    const ex = flakyExtractor();
    const b = quiet(makeEngine({ extractor: ex }));
    await b.engine.remember("u1", { content: "user: I take oat milk in my coffee", force: true });
    await until(() => [...b.warm.rows.values()].some((x) => x.sourceType === "fact"));
    const factRows = [...b.warm.rows.values()].filter((x) => x.sourceType === "fact");
    expect(factRows.length).toBeGreaterThan(0);
    for (const f of factRows) expect(f.factsPendingAt).toBeNull();
  });

  it("no extractor configured: nothing is marked, reconcile is a no-op", async () => {
    const b = quiet(makeEngine());
    const r = await b.engine.remember("u1", { content: "user: I take oat milk in my coffee", force: true });
    expect(b.warm.rows.get(r.id!)?.factsPendingAt).toBeNull();
    const rec = await b.engine.reconcilePendingFacts({});
    expect(rec).toEqual({ scanned: 0, extracted: 0, failed: 0, pending: 0 });
  });

  it("survives a 'restart': a fresh reconcile over the same store finds the debt", async () => {
    // The fake warm store stands in for Postgres: the marker persisted
    // there is all a restarted process has. Simulate the restart by
    // abandoning the failed in-flight work (it was a void promise — the
    // old process took it to the grave) and running only the reconciler.
    const ex = flakyExtractor();
    ex.state.fail = true;
    const b = quiet(makeEngine({ extractor: ex }));
    await b.engine.remember("u1", { content: "user: I take oat milk in my coffee", force: true });
    await until(() => ex.state.calls >= 1);
    expect(await b.warm.countPendingFacts()).toBe(1);

    ex.state.fail = false;
    const r = await b.engine.reconcilePendingFacts({ batchSize: 10 });
    expect(r.extracted).toBe(1);
    expect(await b.warm.countPendingFacts()).toBe(0);
  });
});
