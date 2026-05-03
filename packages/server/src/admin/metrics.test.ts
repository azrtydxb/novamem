import { describe, expect, it } from "vitest";

import { MetricsCollector } from "./metrics.js";

describe("MetricsCollector: counters", () => {
  it("starts at zero", async () => {
    const m = new MetricsCollector();
    const s = await m.snapshot();
    for (const v of Object.values(s.counters)) expect(v).toBe(0);
    expect(s.gauges.last_decay_run_iso).toBeNull();
  });

  it("counters are monotonic", async () => {
    const m = new MetricsCollector();
    m.recordQuery("acme", { warm: 0, cold: 0, graph: 0 });
    m.recordQuery("acme", { warm: 1, cold: 0, graph: 0 });
    m.recordRemember("acme");
    m.recordForget("acme");
    m.recordPromotion();
    m.recordDemotion(2);
    m.markDecayRun(new Date("2026-05-02T10:00:00Z"));
    m.recordOrphansReaped(3);

    const s = await m.snapshot();
    expect(s.counters.queries_total).toBe(2);
    expect(s.counters.queries_zero_hit).toBe(1);
    expect(s.counters.remembers_total).toBe(1);
    expect(s.counters.forgets_total).toBe(1);
    expect(s.counters.promotions_total).toBe(1);
    expect(s.counters.demotions_total).toBe(2);
    expect(s.counters.decay_runs_total).toBe(1);
    expect(s.counters.orphans_reaped_total).toBe(3);
    expect(s.gauges.last_decay_run_iso).toBe("2026-05-02T10:00:00.000Z");
  });

  it("recordQuery splits warm/cold/graph hits and detects zero-hit", async () => {
    const m = new MetricsCollector();
    m.recordQuery("acme", { warm: 2, cold: 3, graph: 1 });
    m.recordQuery("acme", { warm: 0, cold: 0, graph: 0 });

    const s = await m.snapshot();
    expect(s.counters.queries_total).toBe(2);
    expect(s.counters.hits_warm_total).toBe(2);
    expect(s.counters.hits_cold_total).toBe(3);
    expect(s.counters.hits_graph_total).toBe(1);
    expect(s.counters.queries_zero_hit).toBe(1);
  });

  it("per-tenant snapshot isolates one tenant's slice", async () => {
    const m = new MetricsCollector();
    m.recordQuery("acme", { warm: 1, cold: 0, graph: 0 });
    m.recordQuery("acme", { warm: 1, cold: 1, graph: 0 });
    m.recordQuery("contoso", { warm: 0, cold: 0, graph: 0 });
    m.recordRemember("acme");

    const acme = await m.snapshotForUser("acme");
    expect(acme.counters.queries_total).toBe(2);
    expect(acme.counters.hits_warm_total).toBe(2);
    expect(acme.counters.hits_cold_total).toBe(1);
    expect(acme.counters.queries_zero_hit).toBe(0);
    expect(acme.counters.remembers_total).toBe(1);

    const contoso = await m.snapshotForUser("contoso");
    expect(contoso.counters.queries_total).toBe(1);
    expect(contoso.counters.queries_zero_hit).toBe(1);
    expect(contoso.counters.remembers_total).toBe(0);

    // Aggregate snapshot sums them.
    const global = await m.snapshot();
    expect(global.counters.queries_total).toBe(3);
    expect(global.counters.hits_warm_total).toBe(2);
    expect(global.counters.queries_zero_hit).toBe(1);
  });
});

describe("MetricsCollector: rates (60s ring)", () => {
  it("rates reflect events in window", async () => {
    let now = 1_000_000;
    const m = new MetricsCollector({ now: () => now });
    for (let i = 0; i < 120; i++) {
      m.recordQuery("acme", { warm: 1, cold: 0, graph: 0 });
      now += 100; // 100ms apart → 12s span
    }
    const s = await m.snapshot();
    // 120 events over 60s = 2/sec.
    expect(s.rates.queries_per_sec_60s).toBeCloseTo(2, 5);
  });

  it("rates drop to 0 once events age out", async () => {
    let now = 1_000_000;
    const m = new MetricsCollector({ now: () => now });
    m.recordRemember("acme");
    m.recordRemember("acme");
    expect((await m.snapshot()).rates.remembers_per_sec_60s).toBeGreaterThan(0);

    // Jump forward past the window.
    now += 70_000;
    expect((await m.snapshot()).rates.remembers_per_sec_60s).toBe(0);
  });
});

describe("MetricsCollector: gauges via injected sources", () => {
  it("returns sourced values when bound", async () => {
    const m = new MetricsCollector();
    m.bindGaugeSources({
      warmEntries: async () => 42,
      coldEntries: async () => 7,
      graphEdges: async () => 9,
      orphansPending: async () => 1,
    });
    const s = await m.snapshot();
    expect(s.gauges.warm_entries).toBe(42);
    expect(s.gauges.cold_entries).toBe(7);
    expect(s.gauges.graph_edges).toBe(9);
    expect(s.gauges.orphans_pending).toBe(1);
  });

  it("graph_edges is null when source returns null (graph unreachable)", async () => {
    const m = new MetricsCollector();
    m.bindGaugeSources({
      warmEntries: async () => 0,
      coldEntries: async () => 0,
      graphEdges: async () => null,
      orphansPending: async () => 0,
    });
    expect((await m.snapshot()).gauges.graph_edges).toBeNull();
  });

  it("a gauge source that throws becomes null without blanking the others", async () => {
    const m = new MetricsCollector();
    m.bindGaugeSources({
      warmEntries: async () => 5,
      coldEntries: async () => { throw new Error("boom"); },
      graphEdges: async () => 1,
      orphansPending: async () => 0,
    });
    const s = await m.snapshot();
    expect(s.gauges.warm_entries).toBe(5);
    expect(s.gauges.cold_entries).toBeNull();
    expect(s.gauges.graph_edges).toBe(1);
  });

  it("without bound sources, all numeric gauges are null", async () => {
    const m = new MetricsCollector();
    const s = await m.snapshot();
    expect(s.gauges.warm_entries).toBeNull();
    expect(s.gauges.cold_entries).toBeNull();
    expect(s.gauges.graph_edges).toBeNull();
    expect(s.gauges.orphans_pending).toBeNull();
  });
});
