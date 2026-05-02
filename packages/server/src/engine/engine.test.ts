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
    const { id } = await b.engine.remember({ content: "hello world" });
    expect(b.warm.rows.has(id)).toBe(true);
    expect(b.cold.vectors.has(id)).toBe(true);
    expect(b.cold.vectors.get(id)!.namespace).toBe("default");
  });

  it("respects custom namespace + agentName + source", async () => {
    const b = bench();
    const { id } = await b.engine.remember({
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
    const a = await b.engine.remember({ content: "Pascal likes dark roast coffee" });
    const c = await b.engine.remember({ content: "ZWO ASI camera for astrophotography" });
    const r = await b.engine.search({ query: "coffee preference", k: 5 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.id).toBe(a.id);
    expect(b.warm.rows.get(a.id)!.hits).toBe(1);
    // The unrelated entry should not be the top hit
    expect(r.results[0]!.id).not.toBe(c.id);
  });

  it("returns degraded:true when graph is disconnected", async () => {
    const b = bench({ graphConnected: false });
    await b.engine.remember({ content: "hello" });
    const r = await b.engine.search({ query: "hello" });
    expect(r.degraded).toBe(true);
  });

  it("filters keyword search by agentName when provided", async () => {
    const b = bench();
    await b.engine.remember({ content: "shared knowledge", agentName: null });
    const aliceEntry = await b.engine.remember({ content: "shared knowledge", agentName: "alice" });
    const r = await b.engine.search({ query: "shared", agentName: "alice" });
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
    await b.engine.remember({ content: "exact id ABC123 marker" });
    await b.engine.remember({ content: "totally unrelated text" });
    const keywordOnly = await b.engine.search({
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
      const r = await b.engine.remember({ content: `entry ${i}` });
      ids.push(r.id);
      // Force monotonic createdAt ordering
      const row = b.warm.rows.get(r.id)!;
      row.createdAt = new Date(Date.now() + i * 1000);
    }
    const r = await b.engine.recent({ k: 3 });
    expect(r.results.map((x) => x.id)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it("respects since cutoff", async () => {
    const b = bench();
    const old = await b.engine.remember({ content: "old" });
    b.warm.rows.get(old.id)!.createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const fresh = await b.engine.remember({ content: "fresh" });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const r = await b.engine.recent({ since });
    const ids = r.results.map((x) => x.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(old.id);
  });
});

describe("engine.neighbors", () => {
  it("returns graph-neighbour entries with graph signal", async () => {
    const b = bench();
    const a = await b.engine.remember({ content: "alpha" });
    const c = await b.engine.remember({ content: "beta" });
    await b.graph.addEdge(a.id, c.id, "co_occurs", 0.8);
    const r = await b.engine.neighbors({ id: a.id });
    expect(r.results.map((x) => x.id)).toEqual([c.id]);
    expect(r.results[0]!.signals.graph).toBeCloseTo(0.8);
    expect(r.degraded).toBe(false);
  });

  it("returns degraded when graph is disconnected", async () => {
    const b = bench({ graphConnected: false });
    const r = await b.engine.neighbors({ id: "anything" });
    expect(r.degraded).toBe(true);
    expect(r.results).toEqual([]);
  });
});

describe("engine.forget", () => {
  it("removes warm row + cold vector; reports coldDeleteOk:true", async () => {
    const b = bench();
    const { id } = await b.engine.remember({ content: "to remove" });
    const r = await b.engine.forget(id);
    expect(r).toEqual({ deleted: true, coldDeleteOk: true });
    expect(b.warm.rows.has(id)).toBe(false);
    expect(b.cold.vectors.has(id)).toBe(false);
  });

  it("warns + reports coldDeleteOk:false when cold delete fails", async () => {
    const b = bench();
    const { id } = await b.engine.remember({ content: "orphan candidate" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    b.cold.fail = true;
    const r = await b.engine.forget(id);
    expect(r.deleted).toBe(true);
    expect(r.coldDeleteOk).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns deleted:false for unknown ids", async () => {
    const b = bench();
    const r = await b.engine.forget("not-a-real-id");
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
    const fresh = await b.engine.remember({ content: "fresh entry" });
    const stale = await b.engine.remember({ content: "stale entry" });
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
    const popular = await b.engine.remember({ content: "popular" });
    const row = b.warm.rows.get(popular.id)!;
    row.hits = 15; // lifespan = 7 * log2(16) = 28 days
    row.lastAccessed = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14d idle < 28d lifespan
    const r = await b.engine.decay();
    expect(r.demoted).toBe(0);
    expect(b.warm.rows.get(popular.id)!.cold).toBe(false);
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
    await b.engine.remember({ content: "a", namespace: "ns1" });
    const cold = await b.engine.remember({ content: "b", namespace: "ns1" });
    b.warm.rows.get(cold.id)!.cold = true;
    await b.engine.remember({ content: "c", namespace: "ns2" });
    const s = await b.engine.stats();
    expect(s.totalWarm).toBe(2);
    expect(s.totalCold).toBe(1);
    expect(s.byNamespace.ns1).toEqual({ warm: 1, cold: 1 });
    expect(s.byNamespace.ns2).toEqual({ warm: 1, cold: 0 });
  });
});
