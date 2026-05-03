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
export type UserCounterName =
  | "queries_total"
  | "queries_zero_hit"
  | "remembers_total"
  | "forgets_total"
  | "hits_warm_total"
  | "hits_cold_total"
  | "hits_graph_total";

export type GlobalCounterName =
  | UserCounterName
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

export interface TokenMetricsRow {
  /** Hash, not the plaintext — never expose plaintext tokens. */
  tokenHash: string;
  label: string | null;
  counters: {
    queries_total: number;
    remembers_total: number;
    forgets_total: number;
  };
  rates: {
    queries_per_sec_60s: number;
    remembers_per_sec_60s: number;
  };
}

export interface UserMetricsSnapshot {
  userId: string;
  counters: Record<UserCounterName, number>;
  gauges: {
    warm_entries: number | null;
    cold_entries: number | null;
    graph_edges: number | null;
  };
  rates: {
    queries_per_sec_60s: number;
    remembers_per_sec_60s: number;
  };
  /** Optional per-token breakdown — populated when the caller passes a
   *  `tokenHashes` filter (typically the requesting user's own tokens). */
  tokens?: TokenMetricsRow[];
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
export interface UserGaugeSources {
  warmEntries(userId: string): Promise<number>;
  coldEntries(userId: string): Promise<number>;
  graphEdges(userId: string): Promise<number | null>;
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

const ZERO_TENANT_COUNTERS: Record<UserCounterName, number> = {
  queries_total: 0,
  queries_zero_hit: 0,
  remembers_total: 0,
  forgets_total: 0,
  hits_warm_total: 0,
  hits_cold_total: 0,
  hits_graph_total: 0,
};

interface TenantSlot {
  counters: Record<UserCounterName, number>;
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

interface TokenSlot {
  userId: string;
  label: string | null;
  counters: { queries_total: number; remembers_total: number; forgets_total: number };
  queryRing: TimestampRing;
  rememberRing: TimestampRing;
}

function newTokenSlot(userId: string, label: string | null): TokenSlot {
  return {
    userId,
    label,
    counters: { queries_total: 0, remembers_total: 0, forgets_total: 0 },
    queryRing: new TimestampRing(),
    rememberRing: new TimestampRing(),
  };
}

/** Identity for a tenant token in metrics. We carry the hash (stable id)
 *  and the label so the admin UI can render a human-readable line in the
 *  per-token chart without a follow-up DB query. */
export interface TokenIdentity {
  hash: string;
  label: string | null;
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

  /** Per-token slots, keyed by token hash. Created lazily on first
   *  observation and dropped when the parent tenant is forgotten or the
   *  token is revoked. */
  private readonly perToken = new Map<string, TokenSlot>();

  private lastDecayAt: Date | null = null;
  private readonly startedAt = Date.now();
  private gaugeSources: GaugeSources | null = null;
  private tenantGaugeSources: UserGaugeSources | null = null;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  bindGaugeSources(sources: GaugeSources): void {
    this.gaugeSources = sources;
  }

  bindUserGaugeSources(sources: UserGaugeSources): void {
    this.tenantGaugeSources = sources;
  }

  private slot(userId: string): TenantSlot {
    let s = this.perTenant.get(userId);
    if (!s) {
      s = newTenantSlot();
      this.perTenant.set(userId, s);
    }
    return s;
  }

  private tokenSlot(userId: string, token: TokenIdentity): TokenSlot {
    let s = this.perToken.get(token.hash);
    if (!s) {
      s = newTokenSlot(userId, token.label);
      this.perToken.set(token.hash, s);
    } else if (s.label !== token.label) {
      // Re-label if the operator renames a token between observations.
      s.label = token.label;
    }
    return s;
  }

  /** Record a search call. Pass userId + per-tier hit counts. When the
   *  request was authenticated by a tenant bearer token, pass `token` so
   *  the per-token series in /v1/me/metrics reflects this call. */
  recordQuery(
    userId: string,
    hits: { warm: number; cold: number; graph: number },
    token?: TokenIdentity,
  ): void {
    const now = this.now();
    const s = this.slot(userId);
    s.counters.queries_total += 1;
    s.counters.hits_warm_total += hits.warm;
    s.counters.hits_cold_total += hits.cold;
    s.counters.hits_graph_total += hits.graph;
    if (hits.warm + hits.cold + hits.graph === 0) s.counters.queries_zero_hit += 1;
    s.queryRing.record(now);
    if (token) {
      const t = this.tokenSlot(userId, token);
      t.counters.queries_total += 1;
      t.queryRing.record(now);
    }
  }

  recordRemember(userId: string, token?: TokenIdentity): void {
    const now = this.now();
    const s = this.slot(userId);
    s.counters.remembers_total += 1;
    s.rememberRing.record(now);
    if (token) {
      const t = this.tokenSlot(userId, token);
      t.counters.remembers_total += 1;
      t.rememberRing.record(now);
    }
  }

  recordForget(userId: string, token?: TokenIdentity): void {
    this.slot(userId).counters.forgets_total += 1;
    if (token) this.tokenSlot(userId, token).counters.forgets_total += 1;
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

  /** Free a tenant's in-memory slot. Called from `engine.deleteTenant`
   *  so the perTenant Map doesn't accumulate dead entries forever
   *  (review finding P2-5). Also clears any per-token slots scoped to
   *  the tenant. */
  forgetUser(userId: string): void {
    this.perTenant.delete(userId);
    for (const [hash, slot] of this.perToken) {
      if (slot.userId === userId) this.perToken.delete(hash);
    }
  }

  /** Drop a token's slot — called when the token is revoked so the
   *  /v1/me/metrics view stops including it. */
  forgetToken(tokenHash: string): void {
    this.perToken.delete(tokenHash);
  }

  /** Aggregate per-tenant counters across all tenants. */
  private aggregate(): Record<UserCounterName, number> {
    const out: Record<UserCounterName, number> = { ...ZERO_TENANT_COUNTERS };
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

  /** Render the global snapshot in Prometheus exposition format. Cheap
   *  enough to compute on every scrape — gauges resolve via the same
   *  read-through sources as the JSON snapshot (review finding P2-18). */
  async renderProm(): Promise<string> {
    const s = await this.snapshot();
    const lines: string[] = [];
    const counter = (name: string, help: string, value: number) => {
      lines.push(`# HELP novamem_${name} ${help}`);
      lines.push(`# TYPE novamem_${name} counter`);
      lines.push(`novamem_${name} ${value}`);
    };
    const gauge = (name: string, help: string, value: number | null) => {
      lines.push(`# HELP novamem_${name} ${help}`);
      lines.push(`# TYPE novamem_${name} gauge`);
      if (value === null) {
        // Prom doesn't model null; emit NaN per OpenMetrics convention.
        lines.push(`novamem_${name} NaN`);
      } else {
        lines.push(`novamem_${name} ${value}`);
      }
    };
    counter("queries_total", "Total search queries", s.counters.queries_total);
    counter("queries_zero_hit_total", "Search queries returning no fused results", s.counters.queries_zero_hit);
    counter("remembers_total", "Memory entries stored", s.counters.remembers_total);
    counter("forgets_total", "Memory entries forgotten", s.counters.forgets_total);
    counter("hits_warm_total", "Search results contributed by the warm tier", s.counters.hits_warm_total);
    counter("hits_cold_total", "Search results contributed by the cold tier", s.counters.hits_cold_total);
    counter("hits_graph_total", "Search results contributed by the graph tier", s.counters.hits_graph_total);
    counter("promotions_total", "Cold→warm promotions", s.counters.promotions_total);
    counter("demotions_total", "Warm→cold demotions", s.counters.demotions_total);
    counter("decay_runs_total", "Decay loop ticks", s.counters.decay_runs_total);
    counter("orphans_reaped_total", "cold_orphans rows cleared", s.counters.orphans_reaped_total);
    gauge("warm_entries", "Current warm-tier entry count", s.gauges.warm_entries);
    gauge("cold_entries", "Current cold-tier entry count", s.gauges.cold_entries);
    gauge("graph_edges", "Current graph edge count (NaN if FalkorDB unreachable)", s.gauges.graph_edges);
    gauge("orphans_pending", "Pending cold_orphans rows", s.gauges.orphans_pending);
    gauge("queries_per_sec_60s", "Rolling 60s queries/sec", s.rates.queries_per_sec_60s);
    gauge("remembers_per_sec_60s", "Rolling 60s remembers/sec", s.rates.remembers_per_sec_60s);
    gauge("uptime_seconds", "Process uptime (seconds)", Math.floor(s.uptime_ms / 1000));
    return lines.join("\n") + "\n";
  }

  async snapshotForUser(
    userId: string,
    opts: { tokens?: Array<{ hash: string; label: string | null }> } = {},
  ): Promise<UserMetricsSnapshot> {
    const now = this.now();
    const slot = this.slot(userId);
    const seconds = RATE_WINDOW_MS / 1000;

    let gauges: UserMetricsSnapshot["gauges"] = {
      warm_entries: null,
      cold_entries: null,
      graph_edges: null,
    };
    if (this.tenantGaugeSources) {
      const [warm, cold, edges] = await Promise.all([
        this.tenantGaugeSources.warmEntries(userId).catch(() => null),
        this.tenantGaugeSources.coldEntries(userId).catch(() => null),
        this.tenantGaugeSources.graphEdges(userId).catch(() => null),
      ]);
      gauges = { warm_entries: warm, cold_entries: cold, graph_edges: edges };
    }

    let tokens: TokenMetricsRow[] | undefined;
    if (opts.tokens) {
      // Always emit a row per requested token — even if it has no observed
      // traffic yet — so the UI can show a zero-line for freshly-minted
      // tokens. Use the caller-supplied label as the source of truth.
      tokens = opts.tokens.map(({ hash, label }) => {
        const t = this.perToken.get(hash);
        if (!t) {
          return {
            tokenHash: hash,
            label,
            counters: { queries_total: 0, remembers_total: 0, forgets_total: 0 },
            rates: { queries_per_sec_60s: 0, remembers_per_sec_60s: 0 },
          };
        }
        return {
          tokenHash: hash,
          label,
          counters: { ...t.counters },
          rates: {
            queries_per_sec_60s: t.queryRing.count(now) / seconds,
            remembers_per_sec_60s: t.rememberRing.count(now) / seconds,
          },
        };
      });
    }

    return {
      userId,
      counters: { ...slot.counters },
      gauges,
      rates: {
        queries_per_sec_60s: slot.queryRing.count(now) / seconds,
        remembers_per_sec_60s: slot.rememberRing.count(now) / seconds,
      },
      ...(tokens ? { tokens } : {}),
      uptime_ms: now - this.startedAt,
    };
  }
}
