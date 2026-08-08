/**
 * Regression locks for the two-day silent-outage bug: the embeddings host
 * was destroyed, every write still returned success, every vector was
 * missing, and there was no record of which entries were affected.
 *
 * The invariant these tests defend is that a write and its vector can be
 * out of step, but never *silently* out of step — the row itself records
 * that it owes a vector, the caller is told, and the reconciler settles
 * it once the embedder returns.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";

/** Silence the expected ERROR logs so a passing run stays readable. */
function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

describe("write path survives an embedder outage", () => {
  it("stores the entry with embedded_at NULL instead of losing it", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;

    const r = await b.engine.remember("u1", { content: "the deploy host is 10.0.0.9" });

    // The memory itself survived — that is the whole point. Losing it
    // would be strictly worse than storing it unembedded.
    expect(r.id).toBeTruthy();
    expect(b.warm.rows.get(r.id!)?.content).toBe("the deploy host is 10.0.0.9");
    // …and it is marked as owing a vector, which is the queue.
    expect(b.warm.rows.get(r.id!)?.embeddedAt).toBeNull();
    expect(await b.warm.countPendingEmbedding()).toBe(1);
    // No vector was written, so nothing claims to be searchable.
    expect(b.cold.vectors.size).toBe(0);
  });

  it("reports embedded:false rather than unqualified success", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;

    const r = await b.engine.remember("u1", { content: "postgres runs on port 5433" });

    expect(r.embedded).toBe(false);
  });

  it("stamps embedded_at when the embedder is healthy", async () => {
    const b = makeEngine();

    const r = await b.engine.remember("u1", { content: "postgres runs on port 5433" });

    expect(r.embedded).toBe(true);
    expect(b.warm.rows.get(r.id!)?.embeddedAt).toBeInstanceOf(Date);
    expect(await b.warm.countPendingEmbedding()).toBe(0);
  });

  it("logs the failure at ERROR, rate-limited so an outage can't flood", async () => {
    const b = makeEngine();
    const errors: unknown[] = [];
    b.engine.setLogger({ warn: () => {}, error: (o: unknown) => { errors.push(o); }, info: () => {} });
    b.embedder.fail = true;

    for (let i = 0; i < 5; i++) {
      await b.engine.remember("u1", { content: `entry number ${i} of the outage window` });
    }

    // Five failed writes, one log line — the rest are counted, not dropped.
    expect(errors.length).toBe(1);
    expect((errors[0] as { suppressedSinceLastLog: number }).suppressedSinceLastLog).toBe(0);
    expect(await b.warm.countPendingEmbedding()).toBe(5);
  });
});

describe("capture during an embedder outage", () => {
  it("still stores the memory and reports embedded:false", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;

    // capture() embeds *before* writing (for its near-duplicate probe), so
    // an unguarded throw here would drop the caller's memory entirely.
    const r = await b.engine.capture("u1", { content: "pascal prefers dark roast coffee" });

    expect(r.id).toBeTruthy();
    expect(r.embedded).toBe(false);
    expect(b.warm.rows.get(r.id!)?.embeddedAt).toBeNull();
  });

  it("does not claim a deduplicated entry is embedded when it isn't", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;
    const first = await b.engine.capture("u1", { content: "pascal prefers dark roast coffee" });

    // Same content again: the exact-hash fast path returns the existing id.
    // That id belongs to an outage-window row with no vector, and the
    // response must say so rather than inherit this call's optimism.
    const second = await b.engine.capture("u1", { content: "pascal prefers dark roast coffee" });

    expect(second.id).toBe(first.id);
    expect(second.deduplicated).toBe(true);
    expect(second.embedded).toBe(false);
  });
});

describe("reconciler", () => {
  it("drains a backlog once the embedder comes back", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await b.engine.remember("u1", { content: `outage window entry ${i}` });
      ids.push(r.id!);
    }
    expect(await b.warm.countPendingEmbedding()).toBe(3);

    b.embedder.fail = false;
    const result = await b.engine.reconcilePendingEmbeddings({ batchSize: 10 });

    expect(result).toMatchObject({ scanned: 3, embedded: 3, failed: 0, pending: 0 });
    for (const id of ids) {
      expect(b.warm.rows.get(id)?.embeddedAt).toBeInstanceOf(Date);
      expect(b.cold.vectors.has(id)).toBe(true);
    }
  });

  it("is bounded by batchSize and drains oldest-first across ticks", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await b.engine.remember("u1", { content: `outage window entry ${i}` });
      ids.push(r.id!);
      // Distinct createdAt so "oldest first" is actually observable.
      b.warm.rows.get(r.id!)!.createdAt = new Date(1_700_000_000_000 + i * 1000);
    }
    b.embedder.fail = false;

    const first = await b.engine.reconcilePendingEmbeddings({ batchSize: 2 });

    // A large backlog must not become one enormous burst at the embedder.
    expect(first).toMatchObject({ scanned: 2, embedded: 2, pending: 3 });
    // Oldest-first: an outage leaves a contiguous gap, and closing it from
    // its start beats leaving arbitrary holes.
    expect(b.warm.rows.get(ids[0]!)?.embeddedAt).toBeInstanceOf(Date);
    expect(b.warm.rows.get(ids[1]!)?.embeddedAt).toBeInstanceOf(Date);
    expect(b.warm.rows.get(ids[2]!)?.embeddedAt).toBeNull();

    // Subsequent ticks finish the job with no extra coordination.
    await b.engine.reconcilePendingEmbeddings({ batchSize: 2 });
    const last = await b.engine.reconcilePendingEmbeddings({ batchSize: 2 });
    expect(last.pending).toBe(0);
  });

  it("leaves the batch queued when the embedder is still down — no state to lose", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;
    await b.engine.remember("u1", { content: "entry written during the outage" });

    const result = await b.engine.reconcilePendingEmbeddings({ batchSize: 10 });

    expect(result).toMatchObject({ scanned: 1, embedded: 0, failed: 1, pending: 1 });
    // Still queued: retrying next tick needs no retry counter or backoff
    // state, because the pending marker lives on the row itself.
    expect(await b.warm.countPendingEmbedding()).toBe(1);
  });

  it("re-queues an entry whose content changed but whose re-embed failed", async () => {
    const b = quiet(makeEngine());
    const r = await b.engine.remember("u1", { content: "the deploy host is 10.0.0.9" });
    expect(b.warm.rows.get(r.id!)?.embeddedAt).toBeInstanceOf(Date);

    b.embedder.fail = true;
    await b.engine.update("u1", r.id!, { content: "the deploy host is 10.0.0.11" });

    // The stored vector now describes text that no longer exists, so the
    // entry must not keep claiming to be embedded.
    expect(b.warm.rows.get(r.id!)?.embeddedAt).toBeNull();
    expect(await b.warm.countPendingEmbedding()).toBe(1);
  });
});

describe("health reports the embedder without gating readiness", () => {
  it("flags a failing embedder but keeps ok=true", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;
    await b.engine.remember("u1", { content: "entry written during the outage" });
    await b.engine.reconcilePendingEmbeddings({ batchSize: 10 });

    const h = await b.engine.health();

    expect(h.deps.embedder).toBe("failing");
    expect(h.pendingEmbeddings).toBe(1);
    // Deliberate: /ready is driven by `ok`, and keyword + graph search
    // still work. Pulling the service from rotation would turn partial
    // recall loss into total memory loss for every caller.
    expect(h.ok).toBe(true);
  });

  it("returns to ok once the embedder answers again", async () => {
    const b = quiet(makeEngine());
    b.embedder.fail = true;
    await b.engine.remember("u1", { content: "entry written during the outage" });
    b.embedder.fail = false;
    await b.engine.reconcilePendingEmbeddings({ batchSize: 10 });

    const h = await b.engine.health();

    expect(h.deps.embedder).toBe("ok");
    expect(h.pendingEmbeddings).toBe(0);
  });
});
