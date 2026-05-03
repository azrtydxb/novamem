import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryEngine } from "./index.js";
import {
  asCold,
  asGraph,
  asWarm,
  FakeColdStore,
  FakeEmbedder,
  FakeGraphStore,
  FakeWarmStore,
} from "../test-fakes.js";

interface Bench {
  warm: FakeWarmStore;
  cold: FakeColdStore;
  graph: FakeGraphStore;
  embedder: FakeEmbedder;
  engine: MemoryEngine;
}

function bench(opts: { graphConnected?: boolean } = {}): Bench {
  const warm = new FakeWarmStore();
  const cold = new FakeColdStore();
  const graph = new FakeGraphStore();
  graph.connected = opts.graphConnected ?? true;
  const embedder = new FakeEmbedder();
  const engine = new MemoryEngine({
    warm: asWarm(warm),
    cold: asCold(cold),
    graph: asGraph(graph),
    embedder,
    defaultEffectiveDays: 7,
  });
  return { warm, cold, graph, embedder, engine };
}

describe("engine.remember", () => {
  it("stores warm row and a cold vector", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "hello world" });
    expect(b.warm.rows.has(id)).toBe(true);
    expect(b.cold.vectors.has(id)).toBe(true);
    expect(b.cold.vectors.get(id)!.namespace).toBe("default");
  });

  it("respects custom namespace + agentName + source", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", {
      content: "agent-scoped fact",
      namespace: "alice",
      source: "tool.note",
      agentName: "alice",
    });
    expect(b.warm.rows.get(id)!.namespace).toBe("alice");
    expect(b.warm.rows.get(id)!.agentName).toBe("alice");
    expect(b.warm.rows.get(id)!.source).toBe("tool.note");
  });
});

describe("engine.search", () => {
  it("fuses keyword + vector signals; bumps hits on returned ids", async () => {
    const b = bench();
    const a = await b.engine.remember("public", { content: "Pascal likes dark roast coffee" });
    const c = await b.engine.remember("public", { content: "ZWO ASI camera for astrophotography" });
    const r = await b.engine.search("public", { query: "coffee preference", k: 5 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.id).toBe(a.id);
    expect(b.warm.rows.get(a.id)!.hits).toBe(1);
    // The unrelated entry should not be the top hit
    expect(r.results[0]!.id).not.toBe(c.id);
  });

  it("returns degraded:true when graph is disconnected", async () => {
    const b = bench({ graphConnected: false });
    await b.engine.remember("public", { content: "hello" });
    const r = await b.engine.search("public", { query: "hello" });
    expect(r.degraded).toBe(true);
  });

  it("filters keyword search by agentName when provided", async () => {
    const b = bench();
    await b.engine.remember("public", { content: "shared knowledge", agentName: null });
    const aliceEntry = await b.engine.remember("public", { content: "shared knowledge", agentName: "alice" });
    const r = await b.engine.search("public", { query: "shared", agentName: "alice" });
    const ids = r.results.map((x) => x.id);
    expect(ids).toContain(aliceEntry.id);
    // The null-agent entry shouldn't appear in alice-scoped FTS.
    // It might still appear via vector if cold had no agent filter; the
    // signal should be vector-only in that case.
    const stranger = r.results.find((x) => x.id !== aliceEntry.id);
    if (stranger) expect(stranger.signals.keyword).toBe(0);
  });

  it("respects per-call weight overrides", async () => {
    const b = bench();
    await b.engine.remember("public", { content: "exact id ABC123 marker" });
    await b.engine.remember("public", { content: "totally unrelated text" });
    const keywordOnly = await b.engine.search("public", {
      query: "ABC123",
      weights: { keyword: 1, vector: 0, graph: 0 },
    });
    expect(keywordOnly.results[0]!.signals.keyword).toBeGreaterThan(0);
    expect(keywordOnly.results[0]!.score).toBeGreaterThan(0);
  });
});

describe("engine.recent", () => {
  it("returns newest first, limited by k", async () => {
    const b = bench();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await b.engine.remember("public", { content: `entry ${i}` });
      ids.push(r.id);
      // Force monotonic createdAt ordering
      const row = b.warm.rows.get(r.id)!;
      row.createdAt = new Date(Date.now() + i * 1000);
    }
    const r = await b.engine.recent("public", { k: 3 });
    expect(r.results.map((x) => x.id)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it("respects since cutoff", async () => {
    const b = bench();
    const old = await b.engine.remember("public", { content: "old" });
    b.warm.rows.get(old.id)!.createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const fresh = await b.engine.remember("public", { content: "fresh" });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const r = await b.engine.recent("public", { since });
    const ids = r.results.map((x) => x.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(old.id);
  });
});

describe("engine.neighbors", () => {
  it("returns graph-neighbour entries with graph signal", async () => {
    const b = bench();
    const a = await b.engine.remember("public", { content: "alpha" });
    const c = await b.engine.remember("public", { content: "beta" });
    await b.graph.addEdge("public", a.id, c.id, "co_occurs", 0.8);
    const r = await b.engine.neighbors("public", { id: a.id });
    expect(r.results.map((x) => x.id)).toEqual([c.id]);
    expect(r.results[0]!.signals.graph).toBeCloseTo(0.8);
    expect(r.degraded).toBe(false);
  });

  it("returns degraded when graph is disconnected", async () => {
    const b = bench({ graphConnected: false });
    const r = await b.engine.neighbors("public", { id: "anything" });
    expect(r.degraded).toBe(true);
    expect(r.results).toEqual([]);
  });
});

describe("engine.forget", () => {
  it("removes warm row + cold vector; reports coldDeleteOk:true", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "to remove" });
    const r = await b.engine.forget("public", id);
    expect(r).toEqual({ deleted: true, coldDeleteOk: true });
    expect(b.warm.rows.has(id)).toBe(false);
    expect(b.cold.vectors.has(id)).toBe(false);
  });

  it("warns + reports coldDeleteOk:false when cold delete fails", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "orphan candidate" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    b.cold.fail = true;
    const r = await b.engine.forget("public", id);
    expect(r.deleted).toBe(true);
    expect(r.coldDeleteOk).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns deleted:false for unknown ids", async () => {
    const b = bench();
    const r = await b.engine.forget("public", "not-a-real-id");
    expect(r).toEqual({ deleted: false, coldDeleteOk: true });
  });
});

describe("engine.decay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("demotes idle entries past their lifespan; logs the run", async () => {
    const b = bench();
    const fresh = await b.engine.remember("public", { content: "fresh entry" });
    const stale = await b.engine.remember("public", { content: "stale entry" });
    // Make 'stale' look 30 days idle. Fresh is 0 days idle.
    b.warm.rows.get(stale.id)!.lastAccessed = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = await b.engine.decay();
    expect(r.demoted).toBe(1);
    expect(b.warm.rows.get(stale.id)!.cold).toBe(true);
    expect(b.warm.rows.get(fresh.id)!.cold).toBe(false);
    // decay_runs row inserted + finalised
    expect(b.warm.decayRunsInserted).toBe(1);
    expect(b.warm.decayRunsUpdated).toBe(1);
  });

  it("frequently-accessed entries resist decay (lifespan grows with hits)", async () => {
    const b = bench();
    const popular = await b.engine.remember("public", { content: "popular" });
    const row = b.warm.rows.get(popular.id)!;
    row.hits = 15; // lifespan = 7 * log2(16) = 28 days
    row.lastAccessed = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14d idle < 28d lifespan
    const r = await b.engine.decay();
    expect(r.demoted).toBe(0);
    expect(b.warm.rows.get(popular.id)!.cold).toBe(false);
  });
});

describe("engine.search: cold→warm promotion", () => {
  it("a cold entry with lifespan > idle age is promoted on hit", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "previously cold fact" });
    const row = b.warm.rows.get(id)!;
    row.cold = true;
    // hits=20 → lifespan = 7*log2(22) ≈ 31d; idle = 14d → promote.
    row.hits = 20;
    row.lastAccessed = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const r = await b.engine.search("public", { query: "previously cold fact" });
    expect(r.results[0]!.id).toBe(id);
    expect(r.results[0]!.tier).toBe("warm");
    expect(b.warm.rows.get(id)!.cold).toBe(false);
  });

  it("a cold entry with lifespan ≤ idle age stays cold despite the hit", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "deeply cold fact" });
    const row = b.warm.rows.get(id)!;
    row.cold = true;
    // hits=0 → lifespan(1)=7d; idle=30d → stays cold.
    row.hits = 0;
    row.lastAccessed = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = await b.engine.search("public", { query: "deeply cold fact" });
    expect(r.results[0]!.id).toBe(id);
    expect(r.results[0]!.tier).toBe("cold");
    expect(b.warm.rows.get(id)!.cold).toBe(true);
  });

  it("warm entries are unaffected by the promotion path", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "always warm" });
    const r = await b.engine.search("public", { query: "always warm" });
    expect(r.results[0]!.tier).toBe("warm");
    expect(b.warm.rows.get(id)!.cold).toBe(false);
  });
});

describe("engine.remember: graph auto-linking", () => {
  it("links a new entry to its top vector neighbours", async () => {
    const b = bench();
    const a = await b.engine.remember("public", { content: "alpha alpha alpha" });
    const c = await b.engine.remember("public", { content: "alpha alpha beta" });
    // c was just inserted with the most-similar prior entry being a;
    // expect an outgoing edge c → a in both graph and warm relations.
    const cEdges = b.graph.edges.get(`public:_:${c.id}`) ?? [];
    expect(cEdges.some((e) => e.to === a.id)).toBe(true);
    expect(b.warm.relations.some((r) => r.fromId === c.id && r.toId === a.id)).toBe(true);
    // First insert had nothing to link to.
    expect(b.graph.edges.get(`public:_:${a.id}`) ?? []).toEqual([]);
  });

  it("does not link to self", async () => {
    const b = bench();
    const a = await b.engine.remember("public", { content: "solitary" });
    expect(b.graph.edges.get(`public:_:${a.id}`) ?? []).toEqual([]);
    expect(b.warm.relations.find((r) => r.fromId === a.id && r.toId === a.id)).toBeUndefined();
  });
});

describe("engine.reapOrphans", () => {
  it("retries failed cold deletes and clears them on success", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "soon orphan" });
    // Fail the cold delete during forget — should park the orphan.
    b.cold.fail = true;
    const f = await b.engine.forget("public", id);
    expect(f.coldDeleteOk).toBe(false);
    expect(b.warm.coldOrphans.size).toBe(1);
    // Now cold comes back; reaper clears the queue.
    b.cold.fail = false;
    const r = await b.engine.reapOrphans();
    expect(r).toEqual({ attempted: 1, cleared: 1, abandoned: 0, pending: 0, total: 0 });
    expect(b.warm.coldOrphans.size).toBe(0);
  });

  it("abandons after maxAttempts and reports the count", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "stuck orphan" });
    b.cold.fail = true;
    await b.engine.forget("public", id); // attempts: 1
    // Drive attempts up to threshold via repeated reaper passes.
    for (let i = 0; i < 12; i++) {
      await b.engine.reapOrphans({ maxAttempts: 5 });
    }
    const o = b.warm.coldOrphans.get(id)!;
    expect(o.attempts).toBeGreaterThanOrEqual(5);
    // Once at the cap, further passes don't pick it up.
    const tail = await b.engine.reapOrphans({ maxAttempts: 5 });
    expect(tail.attempted).toBe(0);
  });
});

describe("engine.health", () => {
  it("reports ok when all deps respond", async () => {
    const b = bench();
    const h = await b.engine.health();
    expect(h.ok).toBe(true);
    expect(h.deps).toEqual({ warm: "ok", cold: "ok", graph: "ok" });
  });

  it("flags graph disabled when no graph store passed", async () => {
    const warm = new FakeWarmStore();
    const cold = new FakeColdStore();
    const engine = new MemoryEngine({
      warm: asWarm(warm),
      cold: asCold(cold),
      graph: null,
      embedder: new FakeEmbedder(),
    });
    const h = await engine.health();
    expect(h.deps.graph).toBe("disabled");
    expect(h.ok).toBe(true); // warm + cold up is enough
  });

  it("flags cold unreachable + sets ok:false", async () => {
    const b = bench();
    b.cold.fail = true;
    const h = await b.engine.health();
    expect(h.deps.cold).toBe("unreachable");
    expect(h.ok).toBe(false);
  });
});

describe("engine.stats", () => {
  it("aggregates counts per namespace × tier", async () => {
    const b = bench();
    await b.engine.remember("public", { content: "a", namespace: "ns1" });
    const cold = await b.engine.remember("public", { content: "b", namespace: "ns1" });
    b.warm.rows.get(cold.id)!.cold = true;
    await b.engine.remember("public", { content: "c", namespace: "ns2" });
    const s = await b.engine.stats("public");
    expect(s.totalWarm).toBe(2);
    expect(s.totalCold).toBe(1);
    expect(s.byNamespace.ns1).toEqual({ warm: 1, cold: 1 });
    expect(s.byNamespace.ns2).toEqual({ warm: 1, cold: 0 });
  });
});

describe("engine: user isolation", () => {
  it("user B cannot see user A's entries via search", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "Pascal likes dark roast coffee" });
    const r = await b.engine.search("user_b", { query: "coffee preference", k: 5 });
    expect(r.results.find((x) => x.id === a.id)).toBeUndefined();
  });

  it("user B cannot see user A's entries via recent", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "user a memory" });
    const r = await b.engine.recent("user_b", { k: 50 });
    expect(r.results.find((x) => x.id === a.id)).toBeUndefined();
  });

  it("user B cannot forget user A's entries (returns deleted:false; entry survives)", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "user a memory" });
    const r = await b.engine.forget("user_b", a.id);
    expect(r.deleted).toBe(false);
    // Original user can still read it.
    const aRecent = await b.engine.recent("user_a", {});
    expect(aRecent.results.find((x) => x.id === a.id)).toBeDefined();
  });

  it("user B cannot traverse from user A's seed via neighbors", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "user a seed" });
    await b.engine.remember("user_a", { content: "user a neighbour" });
    const r = await b.engine.neighbors("user_b", { id: a.id });
    expect(r.results).toEqual([]);
  });

  it("graph auto-links don't cross users even with similar content", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "alpha alpha alpha" });
    const c = await b.engine.remember("user_b", { content: "alpha alpha alpha" });
    // c should not be linked to a even though their vectors are identical —
    // cold.search is user-scoped, so c sees no neighbours.
    const aEdges = b.graph.edges.get(`user_a:${a.id}`) ?? [];
    const cEdges = b.graph.edges.get(`user_b:${c.id}`) ?? [];
    expect(aEdges).toEqual([]);
    expect(cEdges).toEqual([]);
  });

  it("user-scoped stats only count one user's entries", async () => {
    const b = bench();
    await b.engine.remember("user_a", { content: "a1" });
    await b.engine.remember("user_a", { content: "a2" });
    await b.engine.remember("user_b", { content: "b1" });
    const sA = await b.engine.stats("user_a");
    const sB = await b.engine.stats("user_b");
    expect(sA.totalWarm).toBe(2);
    expect(sB.totalWarm).toBe(1);
  });
});
