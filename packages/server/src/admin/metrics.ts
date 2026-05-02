/**
 * In-process operational metrics for the admin dashboard. Counters are
 * monotonic, gauges are read-through to the stores at snapshot time, and
 * rates are computed from a 60-second ring of event timestamps.
 *
 * Tracks both per-tenant (search/remember/forget/hits) and global counters
 * (decay/promotions/demotions/orphan reaping). Per-tenant counters power
 * the user-scoped /v1/me/metrics endpoint; global counters stay in the
 * admin /v1/admin/metrics view.
 *
 * Restart-resets by design — see openspec/changes/add-admin-dashboard/design.md
 * (decision D3). This is an operational dashboard, not a long-term SLO store.
 */

const RATE_WINDOW_MS = 60_000;

/** Counters tracked per-tenant. The remaining lifecycle counters
 *  (`promotions_total`, `demotions_total`, `decay_runs_total`,
 *  `orphans_reaped_total`) are global only — the decay loop and reaper
 *  are cross-tenant operations. */
export type TenantCounterName =
  | "queries_total"
  | "queries_zero_hit"
  | "remembers_total"
  | "forgets_total"
  | "hits_warm_total"
  | "hits_cold_total"
  | "hits_graph_total";

export type GlobalCounterName =
  | TenantCounterName
  | "promotions_total"
  | "demotions_total"
  | "decay_runs_total"
  | "orphans_reaped_total";

export interface MetricsSnapshot {
  counters: Record<GlobalCounterName, number>;
  gauges: {
    warm_entries: number | null;
    cold_entries: number | null;
    graph_edges: number | null;
    orphans_pending: number | null;
    last_decay_run_iso: string | null;
  };
  rates: {
    queries_per_sec_60s: number;
    remembers_per_sec_60s: number;
  };
  uptime_ms: number;
}

export interface TenantMetricsSnapshot {
  tenantId: string;
  counters: Record<TenantCounterName, number>;
  gauges: {
    warm_entries: number | null;
    cold_entries: number | null;
    graph_edges: number | null;
  };
  rates: {
    queries_per_sec_60s: number;
    remembers_per_sec_60s: number;
  };
  uptime_ms: number;
}

/** Source for global gauges. */
export interface GaugeSources {
  warmEntries(): Promise<number>;
  coldEntries(): Promise<number>;
  /** Resolves to `null` when the graph is unreachable — never throws. */
  graphEdges(): Promise<number | null>;
  orphansPending(): Promise<number>;
}

/** Source for per-tenant gauges. Same contract as GaugeSources but scoped. */
export interface TenantGaugeSources {
  warmEntries(tenantId: string): Promise<number>;
  coldEntries(tenantId: string): Promise<number>;
  graphEdges(tenantId: string): Promise<number | null>;
}

class TimestampRing {
  private buf: number[] = [];

  record(now: number): void {
    this.buf.push(now);
    this.evict(now);
  }

  count(now: number): number {
    this.evict(now);
    return this.buf.length;
  }

  private evict(now: number): void {
    const cutoff = now - RATE_WINDOW_MS;
    let drop = 0;
    while (drop < this.buf.length && this.buf[drop]! < cutoff) drop++;
    if (drop > 0) this.buf.splice(0, drop);
  }
}

const ZERO_TENANT_COUNTERS: Record<TenantCounterName, number> = {
  queries_total: 0,
  queries_zero_hit: 0,
  remembers_total: 0,
  forgets_total: 0,
  hits_warm_total: 0,
  hits_cold_total: 0,
  hits_graph_total: 0,
};

interface TenantSlot {
  counters: Record<TenantCounterName, number>;
  queryRing: TimestampRing;
  rememberRing: TimestampRing;
}

function newTenantSlot(): TenantSlot {
  return {
    counters: { ...ZERO_TENANT_COUNTERS },
    queryRing: new TimestampRing(),
    rememberRing: new TimestampRing(),
  };
}

export class MetricsCollector {
  /** Global lifecycle counters — process-wide, not attributable to a tenant. */
  private readonly globalCounters = {
    promotions_total: 0,
    demotions_total: 0,
    decay_runs_total: 0,
    orphans_reaped_total: 0,
  };

  /** Per-tenant counters + rate rings. Created lazily on first observation. */
  private readonly perTenant = new Map<string, TenantSlot>();

  private lastDecayAt: Date | null = null;
  private readonly startedAt = Date.now();
  private gaugeSources: GaugeSources | null = null;
  private tenantGaugeSources: TenantGaugeSources | null = null;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  bindGaugeSources(sources: GaugeSources): void {
    this.gaugeSources = sources;
  }

  bindTenantGaugeSources(sources: TenantGaugeSources): void {
    this.tenantGaugeSources = sources;
  }

  private slot(tenantId: string): TenantSlot {
    let s = this.perTenant.get(tenantId);
    if (!s) {
      s = newTenantSlot();
      this.perTenant.set(tenantId, s);
    }
    return s;
  }

  /** Record a search call. Pass tenantId + per-tier hit counts. */
  recordQuery(tenantId: string, hits: { warm: number; cold: number; graph: number }): void {
    const s = this.slot(tenantId);
    s.counters.queries_total += 1;
    s.counters.hits_warm_total += hits.warm;
    s.counters.hits_cold_total += hits.cold;
    s.counters.hits_graph_total += hits.graph;
    if (hits.warm + hits.cold + hits.graph === 0) s.counters.queries_zero_hit += 1;
    s.queryRing.record(this.now());
  }

  recordRemember(tenantId: string): void {
    const s = this.slot(tenantId);
    s.counters.remembers_total += 1;
    s.rememberRing.record(this.now());
  }

  recordForget(tenantId: string): void {
    this.slot(tenantId).counters.forgets_total += 1;
  }

  recordPromotion(n = 1): void {
    this.globalCounters.promotions_total += n;
  }

  recordDemotion(n = 1): void {
    this.globalCounters.demotions_total += n;
  }

  recordOrphansReaped(n: number): void {
    this.globalCounters.orphans_reaped_total += n;
  }

  markDecayRun(at: Date = new Date()): void {
    this.globalCounters.decay_runs_total += 1;
    this.lastDecayAt = at;
  }

  /** Aggregate per-tenant counters across all tenants. */
  private aggregate(): Record<TenantCounterName, number> {
    const out: Record<TenantCounterName, number> = { ...ZERO_TENANT_COUNTERS };
    for (const slot of this.perTenant.values()) {
      out.queries_total += slot.counters.queries_total;
      out.queries_zero_hit += slot.counters.queries_zero_hit;
      out.remembers_total += slot.counters.remembers_total;
      out.forgets_total += slot.counters.forgets_total;
      out.hits_warm_total += slot.counters.hits_warm_total;
      out.hits_cold_total += slot.counters.hits_cold_total;
      out.hits_graph_total += slot.counters.hits_graph_total;
    }
    return out;
  }

  /** Aggregate rolling rates across all tenants. */
  private aggregateRates(now: number): { qps: number; rps: number } {
    let qCount = 0;
    let rCount = 0;
    for (const slot of this.perTenant.values()) {
      qCount += slot.queryRing.count(now);
      rCount += slot.rememberRing.count(now);
    }
    const seconds = RATE_WINDOW_MS / 1000;
    return { qps: qCount / seconds, rps: rCount / seconds };
  }

  async snapshot(): Promise<MetricsSnapshot> {
    const now = this.now();
    const aggregated = this.aggregate();
    const { qps, rps } = this.aggregateRates(now);

    let gauges: MetricsSnapshot["gauges"] = {
      warm_entries: null,
      cold_entries: null,
      graph_edges: null,
      orphans_pending: null,
      last_decay_run_iso: this.lastDecayAt ? this.lastDecayAt.toISOString() : null,
    };

    if (this.gaugeSources) {
      const [warm, cold, edges, orphans] = await Promise.all([
        this.gaugeSources.warmEntries().catch(() => null),
        this.gaugeSources.coldEntries().catch(() => null),
        this.gaugeSources.graphEdges().catch(() => null),
        this.gaugeSources.orphansPending().catch(() => null),
      ]);
      gauges = {
        warm_entries: warm,
        cold_entries: cold,
        graph_edges: edges,
        orphans_pending: orphans,
        last_decay_run_iso: this.lastDecayAt ? this.lastDecayAt.toISOString() : null,
      };
    }

    return {
      counters: { ...aggregated, ...this.globalCounters },
      gauges,
      rates: { queries_per_sec_60s: qps, remembers_per_sec_60s: rps },
      uptime_ms: now - this.startedAt,
    };
  }

  async snapshotForTenant(tenantId: string): Promise<TenantMetricsSnapshot> {
    const now = this.now();
    const slot = this.slot(tenantId);
    const seconds = RATE_WINDOW_MS / 1000;

    let gauges: TenantMetricsSnapshot["gauges"] = {
      warm_entries: null,
      cold_entries: null,
      graph_edges: null,
    };
    if (this.tenantGaugeSources) {
      const [warm, cold, edges] = await Promise.all([
        this.tenantGaugeSources.warmEntries(tenantId).catch(() => null),
        this.tenantGaugeSources.coldEntries(tenantId).catch(() => null),
        this.tenantGaugeSources.graphEdges(tenantId).catch(() => null),
      ]);
      gauges = { warm_entries: warm, cold_entries: cold, graph_edges: edges };
    }

    return {
      tenantId,
      counters: { ...slot.counters },
      gauges,
      rates: {
        queries_per_sec_60s: slot.queryRing.count(now) / seconds,
        remembers_per_sec_60s: slot.rememberRing.count(now) / seconds,
      },
      uptime_ms: now - this.startedAt,
    };
  }
}
