import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isContentSuperset, MemoryEngine, tokenJaccard } from "./index.js";
import {
  asCold,
  asWarm,
  FakeColdStore,
  FakeEmbedder,
  FakeWarmStore,
  makeEngine,
} from "../test-fakes.js";

function bench(opts: { graphConnected?: boolean } = {}) {
  return makeEngine({
    graphConnected: opts.graphConnected ?? true,
    defaultEffectiveDays: 7,
  });
}

describe("tokenJaccard (dream-cycle merge gate)", () => {
  it("strips stopwords so near-contradictions don't clear the 0.5 threshold", () => {
    // Without stopword filtering, the two strings tokenise to
    // {pascal, lives, in, dubai} vs {pascal, lives, in, belgium} and
    // share 3/5 = 0.6 — clearing the 0.5 default threshold and merging
    // a contradiction. Filtering the stopword `in` drops both sides to
    // {pascal, lives, X} → 2/4 = 0.5, exactly at the boundary, and the
    // merge gate (`< jaccardMin`) rejects equality, so no merge.
    expect(tokenJaccard("Pascal lives in Dubai", "Pascal lives in Belgium")).toBeLessThanOrEqual(
      0.5,
    );
  });

  it("still returns a high score on near-identical content", () => {
    expect(tokenJaccard("alpha beta gamma delta", "alpha beta gamma delta")).toBeGreaterThanOrEqual(
      0.99,
    );
  });

  it("returns 0 when both sides reduce to nothing", () => {
    expect(tokenJaccard("the and of", "is are was")).toBe(0);
  });
});

describe("engine.remember", () => {
  it("stores warm row and a cold vector", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "hello world", force: true });
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
      agentName: "alice", force: true });
    expect(b.warm.rows.get(id)!.namespace).toBe("alice");
    expect(b.warm.rows.get(id)!.agentName).toBe("alice");
    expect(b.warm.rows.get(id)!.source).toBe("tool.note");
  });
});

describe("engine.search", () => {
  it("fuses keyword + vector signals; bumps hits on returned ids", async () => {
    const b = bench();
    const a = await b.engine.remember("public", { content: "Pascal likes dark roast coffee", force: true });
    const c = await b.engine.remember("public", { content: "ZWO ASI camera for astrophotography", force: true });
    const r = await b.engine.search("public", { query: "coffee preference", k: 5 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.id).toBe(a.id);
    expect(b.warm.rows.get(a.id)!.hits).toBe(1);
    // The unrelated entry should not be the top hit
    expect(r.results[0]!.id).not.toBe(c.id);
  });

  it("returns degraded:true when graph is disconnected", async () => {
    const b = bench({ graphConnected: false });
    await b.engine.remember("public", { content: "hello", force: true });
    const r = await b.engine.search("public", { query: "hello" });
    expect(r.degraded).toBe(true);
  });

  it("filters keyword search by agentName when provided", async () => {
    const b = bench();
    await b.engine.remember("public", { content: "shared knowledge", agentName: null, force: true });
    const aliceEntry = await b.engine.remember("public", { content: "shared knowledge", agentName: "alice", force: true });
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
    await b.engine.remember("public", { content: "exact id ABC123 marker", force: true });
    await b.engine.remember("public", { content: "totally unrelated text", force: true });
    const keywordOnly = await b.engine.search("public", {
      query: "ABC123",
      weights: { keyword: 1, vector: 0, graph: 0 },
    });
    expect(keywordOnly.results[0]!.signals.keyword).toBeGreaterThan(0);
    expect(keywordOnly.results[0]!.score).toBeGreaterThan(0);
  });

  // Regression: a user who wrote everything to a custom namespace
  // (e.g. `diag`) used to get an empty result set when they searched
  // without specifying namespace, because the engine silently defaulted
  // to "default". Now: when neither `namespace` nor `includeNamespaces`
  // is provided, fan out across the namespaces the caller actually has
  // entries in.
  it("when no namespace param is set, fans out across populated namespaces", async () => {
    const b = bench();
    const e = await b.engine.remember("public", {
      content: "alpha beta gamma in custom namespace",
      namespace: "diag",
      force: true,
    });
    // No namespace, no includeNamespaces — old behaviour returned [].
    const r = await b.engine.search("public", { query: "alpha beta gamma" });
    const ids = r.results.map((x) => x.id);
    expect(ids).toContain(e.id);
  });

  it("when no namespace param is set and store is empty, falls back to ['default']", async () => {
    const b = bench();
    // Write nothing. A search shouldn't throw — it should return
    // empty cleanly, just like the old behaviour but without the
    // silent miss-on-data bug.
    const r = await b.engine.search("public", { query: "anything" });
    expect(r.results).toEqual([]);
    expect(r.degraded).toBe(false);
  });
});

describe("engine.recent", () => {
  it("returns newest first, limited by k", async () => {
    const b = bench();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await b.engine.remember("public", { content: `entry ${i}`, force: true });
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
    const old = await b.engine.remember("public", { content: "old", force: true });
    b.warm.rows.get(old.id)!.createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const fresh = await b.engine.remember("public", { content: "fresh", force: true });
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
    const a = await b.engine.remember("public", { content: "alpha", force: true });
    const c = await b.engine.remember("public", { content: "beta", force: true });
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

  // Regression for the FalkorDB driver-decode error path
  // ("expected List or Null but was Path/Edge"). The engine now
  // catches the throw and surfaces it as a degraded result instead of
  // letting it bubble to /v1/neighbors / the MCP tool.
  it("degrades to {results:[], degraded:true} when graph.neighbors throws", async () => {
    const b = bench();
    const a = await b.engine.remember("public", { content: "alpha", force: true });
    // Stub the FakeGraphStore to throw, mirroring a driver-decode error.
    b.graph.neighbors = async () => {
      throw new Error("Type mismatch: expected List or Null but was Path");
    };
    const r = await b.engine.neighbors("public", { id: a.id });
    expect(r).toEqual({ results: [], degraded: true });
  });
});

describe("engine.forget", () => {
  it("removes warm row + cold vector; reports coldDeleteOk:true", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "to remove", force: true });
    const r = await b.engine.forget("public", id);
    expect(r).toEqual({ deleted: true, coldDeleteOk: true });
    expect(b.warm.rows.has(id)).toBe(false);
    expect(b.cold.vectors.has(id)).toBe(false);
  });

  it("warns + reports coldDeleteOk:false when cold delete fails", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "orphan candidate", force: true });
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
    const fresh = await b.engine.remember("public", { content: "fresh entry", force: true });
    const stale = await b.engine.remember("public", { content: "stale entry", force: true });
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
    const popular = await b.engine.remember("public", { content: "popular", force: true });
    const row = b.warm.rows.get(popular.id)!;
    row.hits = 15; // lifespan = 7 * log2(16) = 28 days
    row.lastAccessed = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14d idle < 28d lifespan
    const r = await b.engine.decay();
    expect(r.demoted).toBe(0);
    expect(b.warm.rows.get(popular.id)!.cold).toBe(false);
  });

  it("uses retention policy metadata as the decay base by memory type", async () => {
    const b = bench();
    const pref = await b.engine.remember("public", {
      content: "Pascal prefers concise summaries.",
      force: true,
      metadata: { memoryType: "user_preference", retention: { policy: "long_lived", baseEffectiveDays: 365 } },
    });
    const deployment = await b.engine.remember("public", {
      content: "Deployment image sha-test is current.",
      force: true,
      metadata: { memoryType: "deployment_state", retention: { policy: "current_only", baseEffectiveDays: 30 } },
    });

    const prefRow = b.warm.rows.get(pref.id)!;
    const deploymentRow = b.warm.rows.get(deployment.id)!;
    expect((prefRow.metadata.retention as { baseEffectiveDays?: number }).baseEffectiveDays).toBe(365);
    expect((deploymentRow.metadata.retention as { baseEffectiveDays?: number }).baseEffectiveDays).toBe(30);
    prefRow.hits = 1;
    deploymentRow.hits = 1;
    prefRow.lastAccessed = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    deploymentRow.lastAccessed = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);

    const r = await b.engine.decay();
    expect(r.demoted).toBe(1);
    expect(b.warm.rows.get(pref.id)!.cold).toBe(false);
    expect(b.warm.rows.get(deployment.id)!.cold).toBe(true);
  });
});

describe("engine.search: cold→warm promotion", () => {
  it("a cold entry with lifespan > idle age is promoted on hit", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "previously cold fact", force: true });
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
    const { id } = await b.engine.remember("public", { content: "deeply cold fact", force: true });
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
    const { id } = await b.engine.remember("public", { content: "always warm", force: true });
    const r = await b.engine.search("public", { query: "always warm" });
    expect(r.results[0]!.tier).toBe("warm");
    expect(b.warm.rows.get(id)!.cold).toBe(false);
  });
});

describe("engine.remember: graph auto-linking", () => {
  it("links a new entry to its top vector neighbours", async () => {
    const b = bench();
    const a = await b.engine.remember("public", { content: "alpha alpha alpha", force: true });
    const c = await b.engine.remember("public", { content: "alpha alpha beta", force: true });
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
    const a = await b.engine.remember("public", { content: "solitary", force: true });
    expect(b.graph.edges.get(`public:_:${a.id}`) ?? []).toEqual([]);
    expect(b.warm.relations.find((r) => r.fromId === a.id && r.toId === a.id)).toBeUndefined();
  });
});

describe("engine.reapOrphans", () => {
  it("retries failed cold deletes and clears them on success", async () => {
    const b = bench();
    const { id } = await b.engine.remember("public", { content: "soon orphan", force: true });
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
    const { id } = await b.engine.remember("public", { content: "stuck orphan", force: true });
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
    await b.engine.remember("public", { content: "a", namespace: "ns1", force: true });
    const cold = await b.engine.remember("public", { content: "b", namespace: "ns1", force: true });
    b.warm.rows.get(cold.id)!.cold = true;
    await b.engine.remember("public", { content: "c", namespace: "ns2", force: true });
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
    const a = await b.engine.remember("user_a", { content: "Pascal likes dark roast coffee", force: true });
    const r = await b.engine.search("user_b", { query: "coffee preference", k: 5 });
    expect(r.results.find((x) => x.id === a.id)).toBeUndefined();
  });

  it("user B cannot see user A's entries via recent", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "user a memory", force: true });
    const r = await b.engine.recent("user_b", { k: 50 });
    expect(r.results.find((x) => x.id === a.id)).toBeUndefined();
  });

  it("user B cannot forget user A's entries (returns deleted:false; entry survives)", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "user a memory", force: true });
    const r = await b.engine.forget("user_b", a.id);
    expect(r.deleted).toBe(false);
    // Original user can still read it.
    const aRecent = await b.engine.recent("user_a", {});
    expect(aRecent.results.find((x) => x.id === a.id)).toBeDefined();
  });

  it("user B cannot traverse from user A's seed via neighbors", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "user a seed", force: true });
    await b.engine.remember("user_a", { content: "user a neighbour", force: true });
    const r = await b.engine.neighbors("user_b", { id: a.id });
    expect(r.results).toEqual([]);
  });

  it("graph auto-links don't cross users even with similar content", async () => {
    const b = bench();
    const a = await b.engine.remember("user_a", { content: "alpha alpha alpha", force: true });
    const c = await b.engine.remember("user_b", { content: "alpha alpha alpha", force: true });
    // c should not be linked to a even though their vectors are identical —
    // cold.search is user-scoped, so c sees no neighbours.
    const aEdges = b.graph.edges.get(`user_a:${a.id}`) ?? [];
    const cEdges = b.graph.edges.get(`user_b:${c.id}`) ?? [];
    expect(aEdges).toEqual([]);
    expect(cEdges).toEqual([]);
  });

  it("user-scoped stats only count one user's entries", async () => {
    const b = bench();
    await b.engine.remember("user_a", { content: "a1", force: true });
    await b.engine.remember("user_a", { content: "a2", force: true });
    await b.engine.remember("user_b", { content: "b1", force: true });
    const sA = await b.engine.stats("user_a");
    const sB = await b.engine.stats("user_b");
    expect(sA.totalWarm).toBe(2);
    expect(sB.totalWarm).toBe(1);
  });
});


describe("engine.hygieneReport / evaluateMemoryQuality integrity", () => {
  it("uses real store-facing hygiene methods instead of fake-only rows/vectors fields", async () => {
    const rows = [
      {
        id: "01HYGIENE000000000000000001",
        userId: "public",
        projectId: null,
        content: "tiny",
        namespace: "default",
        metadata: { worthiness: { overall: 0.1 } },
      },
      {
        id: "01HYGIENE000000000000000002",
        userId: "public",
        projectId: null,
        content: "Pascal lives in Dubai",
        namespace: "default",
        metadata: {},
      },
    ];
    const warm = {
      listHygieneEntries: vi.fn(async () => rows),
      ping: vi.fn(async () => true),
    };
    const cold = {
      existingIds: vi.fn(async () => new Set([rows[1]!.id])),
      ping: vi.fn(async () => true),
    };
    const engine = new MemoryEngine({
      warm: warm as unknown as FakeWarmStore,
      cold: cold as unknown as FakeColdStore,
      graph: null,
      embedder: new FakeEmbedder(),
    });

    const report = await engine.hygieneReport("public", { k: 10 });

    expect(warm.listHygieneEntries).toHaveBeenCalledWith("public", { k: 200 });
    expect(cold.existingIds).toHaveBeenCalledWith([
      { id: rows[0]!.id, userId: "public", projectId: null, namespace: "default" },
      { id: rows[1]!.id, userId: "public", projectId: null, namespace: "default" },
    ]);
    expect((report.summary as { scanned: number }).scanned).toBe(2);
    expect(report.lowValue).toEqual([{ id: rows[0]!.id, content: "tiny", reason: "low_worthiness" }]);
    expect(report.orphanCandidates).toEqual([{ id: rows[0]!.id, reason: "warm_without_cold_vector" }]);
  });

  it("evaluates live hygiene behaviour by validating report shape, not dirty production data", async () => {
    const b = bench();
    const spy = vi.spyOn(b.engine, "hygieneReport").mockResolvedValue({
      summary: { scanned: 0, lowValue: 0, stale: 0, duplicateClusters: 0, contradictionCandidates: 0, orphanCandidates: 0 },
      lowValue: [],
      stale: [],
      duplicateClusters: [],
      contradictionCandidates: [],
      orphanCandidates: [],
    });

    const result = await b.engine.evaluateMemoryQuality("public");
    const cases = result.cases as Array<{ name: string; passed: boolean }>;
    const hygiene = cases.find((c) => c.name === "hygiene report exposes review candidates");

    expect(spy).toHaveBeenCalledWith("public", { k: 5 });
    expect(hygiene?.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("fails evaluation when the hygiene report surface is malformed", async () => {
    const b = bench();
    vi.spyOn(b.engine, "hygieneReport").mockResolvedValue({
      summary: { scanned: 0 },
    } as never);

    const result = await b.engine.evaluateMemoryQuality("public");
    const cases = result.cases as Array<{ name: string; passed: boolean }>;
    const hygiene = cases.find((c) => c.name === "hygiene report exposes review candidates");

    expect(hygiene?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe("engine.capture: overwrite guard (data-loss regression)", () => {
  it("does not overwrite a distinct fact that is merely vector-similar", async () => {
    const { engine, embedder, warm } = bench();
    // Force both facts into near-identical vector space so the semantic
    // duplicate threshold (0.92) is comfortably cleared. Their token sets
    // barely overlap, which is the signal that they are different facts.
    const shared = [1, 0, 0, 0];
    embedder.table.set("Wife's birthday is May 3", shared);
    embedder.table.set("Daughter's birthday is May 3", [0.999, 0.045, 0, 0]);

    const first = await engine.capture("u1", { content: "Wife's birthday is May 3" });
    const second = await engine.capture("u1", { content: "Daughter's birthday is May 3" });

    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    // The critical assertion: a NEW entry, not an in-place overwrite.
    expect(second.id).not.toBe(first.id);
    expect(second.updated).not.toBe(true);

    // And the original fact must still be stored, unchanged.
    expect(warm.rows.get(first.id!)?.content).toBe("Wife's birthday is May 3");
  });

  it("still updates in place when the texts really are restatements", async () => {
    const { engine, embedder } = bench();
    const shared = [1, 0, 0, 0];
    embedder.table.set("The deploy target is the novanas cluster", shared);
    embedder.table.set("The deploy target is the novanas cluster now", [0.999, 0.045, 0, 0]);

    const first = await engine.capture("u1", {
      content: "The deploy target is the novanas cluster",
    });
    const second = await engine.capture("u1", {
      content: "The deploy target is the novanas cluster now",
    });

    expect(second.id).toBe(first.id);
    expect(second.updated).toBe(true);
  });
});

describe("engine.remember: cold-vector repair (insert-side orphan)", () => {
  it("parks an entry for backfill when the cold upsert fails", async () => {
    const { engine, warm, cold } = bench();
    cold.fail = true;
    await expect(engine.remember("u1", { content: "a durable fact worth keeping" })).rejects.toThrow();
    // Warm row committed, vector missing → queued for repair.
    const parked = [...warm.coldOrphans.values()].filter((o) => o.kind === "backfill");
    expect(parked).toHaveLength(1);
  });

  it("backfills the missing vector when the same content is remembered again", async () => {
    const { engine, warm, cold } = bench();
    cold.fail = true;
    await expect(engine.remember("u1", { content: "a durable fact worth keeping" })).rejects.toThrow();
    expect(cold.vectors.size).toBe(0);

    // Qdrant recovers. The dedup fast-path used to return the existing id
    // and bump hits without ever noticing the entry had no vector, so it
    // stayed invisible to vector search forever.
    cold.fail = false;
    const again = await engine.remember("u1", { content: "a durable fact worth keeping" });
    expect(again.deduplicated).toBe(true);
    expect(cold.vectors.size).toBe(1);
    expect(warm.coldOrphans.size).toBe(0);
  });

  it("reapOrphans re-embeds a parked backfill entry", async () => {
    const { engine, warm, cold } = bench();
    cold.fail = true;
    await expect(engine.remember("u1", { content: "another durable fact to keep" })).rejects.toThrow();
    expect(warm.coldOrphans.size).toBe(1);

    cold.fail = false;
    const r = await engine.reapOrphans();
    expect(r.cleared).toBe(1);
    expect(cold.vectors.size).toBe(1);
    expect(warm.coldOrphans.size).toBe(0);
  });
});

describe("engine.remember: content length gate", () => {
  it("rejects content past the embedding window instead of half-storing it", async () => {
    const { engine } = makeEngine({ maxContentChars: 100 });
    const long = "x".repeat(101);
    const r = await engine.remember("u1", { content: long });
    expect(r.id).toBeNull();
    expect(r.rejected).toMatch(/too long/);
  });

  it("accepts content at the limit", async () => {
    const { engine } = makeEngine({ maxContentChars: 100 });
    const r = await engine.remember("u1", { content: "y".repeat(100) });
    expect(r.id).toBeTruthy();
  });
});

describe("engine.search: query vs document embedding sides", () => {
  it("embeds stored content as a document and the query as a query", async () => {
    const { engine, embedder } = bench();
    await engine.remember("u1", { content: "asymmetric retrieval needs prefixes" });
    embedder.calls.length = 0;
    await engine.search("u1", { query: "what needs prefixes" });
    const queryCalls = embedder.calls.filter((c) => c.kind === "query");
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.input).toEqual(["what needs prefixes"]);
  });
});

describe("engine.search: noise floor", () => {
  it("drops vector-only candidates below the configured cosine floor", async () => {
    const { engine, embedder } = makeEngine({ minVectorScore: 0.5 });
    // Orthogonal vectors → cosine 0, well below the floor, and no
    // keyword signal because the fake FTS matches on token overlap.
    embedder.table.set("completely unrelated stored content", [1, 0, 0, 0]);
    embedder.table.set("zzz", [0, 1, 0, 0]);
    await engine.remember("u1", { content: "completely unrelated stored content" });
    const r = await engine.search("u1", { query: "zzz" });
    expect(r.results).toHaveLength(0);
  });
});

describe("isContentSuperset (capture overwrite gate)", () => {
  it("permits an overwrite when the new text only adds detail", () => {
    expect(isContentSuperset("deploy target is novanas", "deploy target is novanas now")).toBe(true);
    expect(isContentSuperset("user prefers dark mode", "user prefers dark mode in the terminal")).toBe(true);
  });

  it("blocks an overwrite when the new text drops a content word", () => {
    // The motivating case: identical scalars, near-identical shape,
    // different subject. A Jaccard threshold does NOT catch this — these
    // two share `s`, `birthday`, `may`, `3`, for an overlap of ~0.67.
    expect(tokenJaccard("Wife's birthday is May 3", "Daughter's birthday is May 3"))
      .toBeGreaterThan(0.5);
    expect(isContentSuperset("Wife's birthday is May 3", "Daughter's birthday is May 3"))
      .toBe(false);
    expect(isContentSuperset("Pascal lives in Dubai", "Pascal lives in Belgium")).toBe(false);
  });

  it("ignores stop words when judging containment", () => {
    expect(isContentSuperset("the server is on novanas", "server on novanas")).toBe(true);
  });
});
