/**
 * In-process operational metrics for the admin dashboard. Counters are
 * monotonic, gauges are read-through to the stores at snapshot time, and
 * rates are computed from a 60-second ring of event timestamps.
 *
 * Tracks both per-user (search/remember/forget/hits) and global counters
 * (decay/promotions/demotions/orphan reaping). Per-user counters power
 * the user-scoped /v1/me/metrics endpoint; global counters stay in the
 * admin /v1/admin/metrics view.
 *
 * Restart-resets by design — see openspec/changes/add-admin-dashboard/design.md
 * (decision D3). This is an operational dashboard, not a long-term SLO store.
 */

const RATE_WINDOW_MS = 60_000;

/** Cap on distinct users / tokens held in memory. The per-user and
 *  per-token maps previously grew without bound, which is fine for a
 *  handful of operators and a slow leak for a large multi-tenant
 *  deployment (or anything that mints short-lived tokens). Eviction is
 *  least-recently-observed. */
const MAX_TRACKED_USERS = 10_000;
const MAX_TRACKED_TOKENS = 10_000;

/** Latency sketch: fixed exponential buckets in milliseconds, plus count
 *  and sum. Enough to render p50/p95/p99 on the dashboard and to export
 *  a Prometheus histogram, without retaining per-request samples. */
const LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

export interface LatencySketch {
  count: number;
  sumMs: number;
  /** One entry per LATENCY_BUCKETS_MS boundary, plus a final +Inf slot. */
  buckets: number[];
}

function newLatencySketch(): LatencySketch {
  return { count: 0, sumMs: 0, buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) };
}

function observeLatency(sketch: LatencySketch, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  sketch.count += 1;
  sketch.sumMs += ms;
  let i = 0;
  while (i < LATENCY_BUCKETS_MS.length && ms > LATENCY_BUCKETS_MS[i]!) i += 1;
  sketch.buckets[i] = (sketch.buckets[i] ?? 0) + 1;
}

/** Approximate quantile from the bucket counts. Returns the upper bound
 *  of the bucket the quantile falls in (null when no samples). */
export function latencyQuantile(sketch: LatencySketch, q: number): number | null {
  if (sketch.count === 0) return null;
  const target = q * sketch.count;
  let cumulative = 0;
  for (let i = 0; i < sketch.buckets.length; i += 1) {
    cumulative += sketch.buckets[i] ?? 0;
    if (cumulative >= target) return LATENCY_BUCKETS_MS[i] ?? Infinity;
  }
  return Infinity;
}

/** Counters tracked per-user. The remaining lifecycle counters
 *  (`promotions_total`, `demotions_total`, `decay_runs_total`,
 *  `orphans_reaped_total`) are global only — the decay loop and reaper
 *  are cross-user operations. */
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
  | "orphans_reaped_total"
  /** Failed operations, by hot path. Without these the dashboard showed
   *  request *counts* only — `recordQuery` fires exclusively on success,
   *  so an error spike was invisible: throughput simply dropped and
   *  nothing said why. */
  | "search_errors_total"
  | "remember_errors_total";

export interface MetricsSnapshot {
  counters: Record<GlobalCounterName, number>;
  gauges: {
    warm_entries: number | null;
    cold_entries: number | null;
    graph_edges: number | null;
    orphans_pending: number | null;
    /** Entries stored with no vector yet. Non-zero is normal for a few
     *  seconds after a write; a value that stays up means the embedder is
     *  gone and the store is quietly losing semantic recall. This is the
     *  gauge to alert on. */
    pending_embeddings: number | null;
    /** Chunks whose fact extraction has not completed
     *  (facts_pending_at IS NOT NULL). Same alerting logic as
     *  pending_embeddings: a value that stops falling while the
     *  extraction endpoint is up means facts are quietly not being
     *  produced. */
    pending_facts: number | null;
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
  pendingEmbeddings(): Promise<number>;
  /** Chunks whose fact extraction has not completed. */
  pendingFacts(): Promise<number>;
}

/** Source for per-user gauges. Same contract as GaugeSources but scoped. */
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

/** Drop least-recently-inserted entries until the map fits `max`. */
function evictOldest(map: Map<string, unknown>, max: number): void {
  if (map.size <= max) return;
  const excess = map.size - max;
  let dropped = 0;
  for (const key of map.keys()) {
    map.delete(key);
    dropped += 1;
    if (dropped >= excess) break;
  }
}

const ZERO_USER_COUNTERS: Record<UserCounterName, number> = {
  queries_total: 0,
  queries_zero_hit: 0,
  remembers_total: 0,
  forgets_total: 0,
  hits_warm_total: 0,
  hits_cold_total: 0,
  hits_graph_total: 0,
};

interface UserSlot {
  counters: Record<UserCounterName, number>;
  queryRing: TimestampRing;
  rememberRing: TimestampRing;
  /** Pending (queries, remembers) accumulated since the last flush to the
   *  persistent metrics_samples table. Reset on each flush. The live
   *  rings above are independent — they're used for the in-mem live
   *  chart and survive the flush. */
  pendingQueries: number;
  pendingRemembers: number;
}

function newUserSlot(): UserSlot {
  return {
    counters: { ...ZERO_USER_COUNTERS },
    queryRing: new TimestampRing(),
    rememberRing: new TimestampRing(),
    pendingQueries: 0,
    pendingRemembers: 0,
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

/** Identity for a user bearer in metrics. We carry the hash (stable id)
 *  and the label so the admin UI can render a human-readable line in the
 *  per-token chart without a follow-up DB query. */
export interface TokenIdentity {
  hash: string;
  label: string | null;
}

export class MetricsCollector {
  /** Global lifecycle counters — process-wide, not attributable to a single user. */
  private readonly globalCounters = {
    promotions_total: 0,
    demotions_total: 0,
    decay_runs_total: 0,
    orphans_reaped_total: 0,
    search_errors_total: 0,
    remember_errors_total: 0,
  };

  /** Latency distributions for the two hot paths. */
  private readonly latency: Record<"search" | "remember", LatencySketch> = {
    search: newLatencySketch(),
    remember: newLatencySketch(),
  };

  /** Per-user counters + rate rings. Created lazily on first observation. */
  private readonly perUser = new Map<string, UserSlot>();

  /** Per-token slots, keyed by token hash. Created lazily on first
   *  observation and dropped when the parent user is forgotten or the
   *  token is revoked. */
  private readonly perToken = new Map<string, TokenSlot>();

  private lastDecayAt: Date | null = null;
  private readonly startedAt = Date.now();
  private gaugeSources: GaugeSources | null = null;
  private userGaugeSources: UserGaugeSources | null = null;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  bindGaugeSources(sources: GaugeSources): void {
    this.gaugeSources = sources;
  }

  bindUserGaugeSources(sources: UserGaugeSources): void {
    this.userGaugeSources = sources;
  }

  private slot(userId: string): UserSlot {
    let s = this.perUser.get(userId);
    if (!s) {
      s = newUserSlot();
      this.perUser.set(userId, s);
      evictOldest(this.perUser, MAX_TRACKED_USERS);
    } else {
      // Refresh recency: Map preserves insertion order, so re-inserting
      // moves this user to the young end and keeps eviction LRU-ish.
      this.perUser.delete(userId);
      this.perUser.set(userId, s);
    }
    return s;
  }

  /** Record a failed hot-path operation. Paired with the latency sketch
   *  so the dashboard can show error rate alongside throughput. */
  recordError(path: "search" | "remember"): void {
    if (path === "search") this.globalCounters.search_errors_total += 1;
    else this.globalCounters.remember_errors_total += 1;
  }

  /** Record how long a hot-path operation took, successful or not. */
  recordLatency(path: "search" | "remember", ms: number): void {
    observeLatency(this.latency[path], ms);
  }

  /** Read-only view of the latency sketches, for the admin snapshot. */
  latencySnapshot(): Record<"search" | "remember", { count: number; p50: number | null; p95: number | null; p99: number | null; avgMs: number | null }> {
    const one = (sk: LatencySketch) => ({
      count: sk.count,
      p50: latencyQuantile(sk, 0.5),
      p95: latencyQuantile(sk, 0.95),
      p99: latencyQuantile(sk, 0.99),
      avgMs: sk.count > 0 ? sk.sumMs / sk.count : null,
    });
    return { search: one(this.latency.search), remember: one(this.latency.remember) };
  }

  private tokenSlot(userId: string, token: TokenIdentity): TokenSlot {
    let s = this.perToken.get(token.hash);
    if (!s) {
      evictOldest(this.perToken, MAX_TRACKED_TOKENS - 1);
      s = newTokenSlot(userId, token.label);
      this.perToken.set(token.hash, s);
    } else if (s.label !== token.label) {
      // Re-label if the operator renames a token between observations.
      s.label = token.label;
    }
    return s;
  }

  /** Record a search call. Pass userId + per-tier hit counts. When the
   *  request was authenticated by a user bearer token, pass `token` so
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
    s.pendingQueries += 1;
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
    s.pendingRemembers += 1;
    if (token) {
      const t = this.tokenSlot(userId, token);
      t.counters.remembers_total += 1;
      t.rememberRing.record(now);
    }
  }

  /** Drain per-user pending counters into a flushable batch. Called by
   *  the periodic loop in main.ts; counters reset to 0 atomically here.
   *  Returns the rows the caller should INSERT into metrics_samples. */
  drainPendingSamples(sampledAt: Date): Array<{
    userId: string;
    sampledAt: Date;
    queries: number;
    remembers: number;
  }> {
    const out: Array<{ userId: string; sampledAt: Date; queries: number; remembers: number }> = [];
    for (const [userId, s] of this.perUser) {
      if (s.pendingQueries === 0 && s.pendingRemembers === 0) continue;
      out.push({
        userId,
        sampledAt,
        queries: s.pendingQueries,
        remembers: s.pendingRemembers,
      });
      s.pendingQueries = 0;
      s.pendingRemembers = 0;
    }
    return out;
  }

  /** Put a drained batch back after a failed flush. `drainPendingSamples`
   *  zeroes the counters before the caller's INSERT runs, so without this
   *  a transient database error silently dropped a whole sample window
   *  from the 24h throughput history. Adds rather than assigns, since
   *  fresh traffic may have incremented the counters in the meantime. */
  restorePendingSamples(
    samples: Array<{ userId: string; queries: number; remembers: number }>,
  ): void {
    for (const s of samples) {
      const slot = this.slot(s.userId);
      slot.pendingQueries += s.queries;
      slot.pendingRemembers += s.remembers;
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


  /** Drop a token's slot — called when the token is revoked so the
   *  /v1/me/metrics view stops including it. */
  forgetToken(tokenHash: string): void {
    this.perToken.delete(tokenHash);
  }

  /** Aggregate per-user counters across all users. */
  private aggregate(): Record<UserCounterName, number> {
    const out: Record<UserCounterName, number> = { ...ZERO_USER_COUNTERS };
    for (const slot of this.perUser.values()) {
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

  /** Aggregate rolling rates across all users. */
  private aggregateRates(now: number): { qps: number; rps: number } {
    let qCount = 0;
    let rCount = 0;
    for (const slot of this.perUser.values()) {
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
      pending_embeddings: null,
      pending_facts: null,
      last_decay_run_iso: this.lastDecayAt ? this.lastDecayAt.toISOString() : null,
    };

    if (this.gaugeSources) {
      const [warm, cold, edges, orphans, pendingEmbeddings, pendingFacts] = await Promise.all([
        this.gaugeSources.warmEntries().catch(() => null),
        this.gaugeSources.coldEntries().catch(() => null),
        this.gaugeSources.graphEdges().catch(() => null),
        this.gaugeSources.orphansPending().catch(() => null),
        this.gaugeSources.pendingEmbeddings().catch(() => null),
        this.gaugeSources.pendingFacts().catch(() => null),
      ]);
      gauges = {
        warm_entries: warm,
        cold_entries: cold,
        graph_edges: edges,
        orphans_pending: orphans,
        pending_embeddings: pendingEmbeddings,
        pending_facts: pendingFacts,
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
   *  read-through sources as the JSON snapshot. */
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
    gauge(
      "pending_embeddings",
      "Entries stored with no vector yet (embedded_at IS NULL) — alert if this stops falling",
      s.gauges.pending_embeddings,
    );
    gauge(
      "pending_facts",
      "Chunks whose fact extraction has not completed (facts_pending_at IS NOT NULL) — alert if this stops falling",
      s.gauges.pending_facts,
    );
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
    if (this.userGaugeSources) {
      const [warm, cold, edges] = await Promise.all([
        this.userGaugeSources.warmEntries(userId).catch(() => null),
        this.userGaugeSources.coldEntries(userId).catch(() => null),
        this.userGaugeSources.graphEdges(userId).catch(() => null),
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
