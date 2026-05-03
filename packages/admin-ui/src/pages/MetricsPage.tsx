import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpToLine,
  Database,
  Flame,
  Network,
  RefreshCw,
  Search,
  Snowflake,
  Trash2,
  Zap,
} from "lucide-react";
import { api, MetricsSnapshot, TenantMetricsSnapshot } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/Card";
import { StatCard } from "../components/StatCard";
import { Button } from "../components/Button";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { useToast } from "../components/Toast";
import { fmtNumber, fmtRelative } from "../lib/utils";

const POLL_MS = 5000;
const HISTORY_POINTS = 30; // 30 samples × 5s ≈ 2.5 minutes of data

interface HistoryPoint {
  t: number;
  qps: number;
  rps: number;
  warmHits: number;
  coldHits: number;
  graphHits: number;
  /** Per-token qps keyed by tokenHash. Sparse — only tokens that existed
   *  in this snapshot have a value; `undefined` is rendered as a gap by
   *  recharts so a freshly-revoked token disappears cleanly from the chart. */
  byToken: Record<string, number>;
}

/** Stable colour palette for per-token lines. Cycles after 8 tokens —
 *  more than enough for a typical user, and we'd switch to a hash-based
 *  scheme if anyone hit that wall. */
const TOKEN_COLORS = [
  "#fbbf24",
  "#f87171",
  "#a78bfa",
  "#34d399",
  "#60a5fa",
  "#f472b6",
  "#fb923c",
  "#22d3ee",
];

function tokenColor(idx: number): string {
  return TOKEN_COLORS[idx % TOKEN_COLORS.length]!;
}

function tokenShortLabel(row: { tokenHash: string; label: string | null }): string {
  return row.label && row.label.trim() !== ""
    ? row.label
    : `token ${row.tokenHash.slice(0, 6)}`;
}

/** Discriminated union: admins fetch the global snapshot which includes
 *  lifecycle counters + orphans gauge. Users fetch a tenant-scoped snapshot
 *  which omits those (decay/promotions are cross-tenant). */
type AnySnapshot =
  | { kind: "admin"; data: MetricsSnapshot }
  | { kind: "user"; data: TenantMetricsSnapshot };

function isAdminSnapshot(s: AnySnapshot): s is { kind: "admin"; data: MetricsSnapshot } {
  return s.kind === "admin";
}

export function MetricsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Always call /v1/me/metrics so we get the per-token series (admin
  // gets the global counters + their own tokens; user gets tenant-scoped
  // counters + their own tokens). The admin-only /v1/admin/metrics
  // endpoint still exists for Prometheus / scripts.
  const endpoint = "/v1/me/metrics";

  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const lastCountersRef = useRef<AnySnapshot["data"]["counters"] | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();

  // TanStack Query handles polling, retries, and refetch-on-focus. The
  // `useEffect` block below derives the chart history from each snapshot
  // — that's the one piece of bespoke state still needed.
  const {
    data: snap,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["metrics", endpoint],
    queryFn: async () => {
      const r = await api<MetricsSnapshot | TenantMetricsSnapshot>("GET", endpoint);
      if (!r.ok || !r.body) throw new Error(r.error ?? `metrics ${r.status}`);
      return isAdmin
        ? ({ kind: "admin", data: r.body as MetricsSnapshot } as AnySnapshot)
        : ({ kind: "user", data: r.body as TenantMetricsSnapshot } as AnySnapshot);
    },
    refetchInterval: POLL_MS,
  });

  // Append a chart point each time a snapshot lands.
  useEffect(() => {
    if (!snap) return;
    const prev = lastCountersRef.current;
    lastCountersRef.current = snap.data.counters;
    setHistory((cur) => {
      const last = cur[cur.length - 1];
      const t = Date.now();
      const byToken: Record<string, number> = {};
      const tokenRows = snap.data.tokens;
      if (tokenRows) {
        for (const row of tokenRows) byToken[row.tokenHash] = row.rates.queries_per_sec_60s;
      }
      const point: HistoryPoint = {
        t,
        qps: snap.data.rates.queries_per_sec_60s,
        rps: snap.data.rates.remembers_per_sec_60s,
        warmHits: prev ? snap.data.counters.hits_warm_total - prev.hits_warm_total : 0,
        coldHits: prev ? snap.data.counters.hits_cold_total - prev.hits_cold_total : 0,
        graphHits: prev ? snap.data.counters.hits_graph_total - prev.hits_graph_total : 0,
        byToken,
      };
      const out = last && t - last.t < 1000 ? cur : [...cur, point];
      return out.slice(-HISTORY_POINTS);
    });
  }, [snap]);

  const decay = useMutation({
    mutationFn: async () => {
      const r = await api<{ demoted: number; promoted: number }>("POST", "/v1/decay", {});
      if (!r.ok || !r.body) throw new Error(r.error ?? `decay ${r.status}`);
      return r.body;
    },
    onSuccess: (body) => {
      toast.success("Decay run complete", `demoted ${body.demoted}, promoted ${body.promoted}`);
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
    onError: (err) => {
      toast.error("Decay run failed", (err as Error).message);
    },
  });

  if (!snap) {
    return <SkeletonMetrics />;
  }
  const busy = isFetching;
  const decayBusy = decay.isPending;
  const load = () => void refetch();
  const runDecay = () => decay.mutate();

  const c = snap.data.counters;
  const g = snap.data.gauges;
  const adminGauges = isAdminSnapshot(snap) ? snap.data.gauges : null;
  const totalHits = c.hits_warm_total + c.hits_cold_total + c.hits_graph_total;
  const pct = (n: number) => (totalHits === 0 ? 0 : (n / totalHits) * 100);

  return (
    <>
      <PageHeader
        title={
          <div className="flex items-center gap-2">
            <span>Metrics</span>
            <Pill tone="accent" dot pulse>
              live · {POLL_MS / 1000}s
            </Pill>
            {!isAdmin && user?.userId ? (
              <Pill tone="neutral">tenant: {user.userId}</Pill>
            ) : null}
          </div>
        }
        subtitle={
          isAdmin
            ? "Operational counters, gauges, and rates. In-memory; resets on restart."
            : "Activity for your tenant only. In-memory; resets on restart."
        }
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={load} loading={busy}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            {isAdmin ? (
              <Button size="sm" variant="primary" onClick={runDecay} loading={decayBusy}>
                <ArrowDownToLine className="h-3.5 w-3.5" /> Run decay
              </Button>
            ) : null}
          </>
        }
      />
      <div className="p-5 space-y-5">
      {/* Top: rolling rates + uptime */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Search}
          label="Queries / sec"
          value={fmtNumber(snap.data.rates.queries_per_sec_60s)}
          sublabel="rolling 60s"
          tone="accent"
          trend={history.map((p) => p.qps)}
        />
        <StatCard
          icon={Zap}
          label="Remembers / sec"
          value={fmtNumber(snap.data.rates.remembers_per_sec_60s)}
          sublabel="rolling 60s"
          tone="graph"
          trend={history.map((p) => p.rps)}
        />
        <StatCard
          icon={Activity}
          label="Total queries"
          value={fmtNumber(c.queries_total)}
          sublabel={`${fmtNumber(c.queries_zero_hit)} zero-hit`}
          trend={history.map((p) => p.qps)}
        />
        {isAdmin && adminGauges ? (
          <StatCard
            icon={Database}
            label="Last decay"
            value={adminGauges.last_decay_run_iso ? fmtRelative(adminGauges.last_decay_run_iso) : "never"}
            sublabel={
              isAdminSnapshot(snap) ? `${fmtNumber(snap.data.counters.decay_runs_total)} total runs` : ""
            }
          />
        ) : (
          <StatCard
            icon={Zap}
            label="Total remembers"
            value={fmtNumber(c.remembers_total)}
            sublabel={`${fmtNumber(c.forgets_total)} forgets`}
          />
        )}
      </div>

      {/* Activity chart — total queries/remembers as filled areas, plus a
          dashed line per individual token so the user can see their
          breakdown alongside the aggregate. */}
      <Card>
        <CardHeader>
          <CardTitle>Throughput</CardTitle>
          <CardDescription>
            Queries and remembers per second, last {HISTORY_POINTS * (POLL_MS / 1000)}s.
            {snap.data.tokens && snap.data.tokens.length > 0
              ? " Dashed lines show per-token query rates."
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke="#222836" strokeDasharray="2 4" />
                <XAxis
                  dataKey="t"
                  tickFormatter={(t) => new Date(t).toLocaleTimeString().slice(0, 5)}
                  stroke="#5b6373"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis stroke="#5b6373" fontSize={11} tickLine={false} axisLine={false} width={32} />
                <Tooltip
                  contentStyle={{
                    background: "#11141b",
                    border: "1px solid #2c3344",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelFormatter={(t) => new Date(t as number).toLocaleTimeString()}
                  formatter={(v: number) => (typeof v === "number" ? v.toFixed(2) : v)}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                <Line
                  type="monotone"
                  dataKey="qps"
                  name="queries/s (total)"
                  stroke="#7c9cff"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="rps"
                  name="remembers/s (total)"
                  stroke="#4ade80"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                {(snap.data.tokens ?? []).map((tok, i) => (
                  <Line
                    key={tok.tokenHash}
                    type="monotone"
                    dataKey={(p: HistoryPoint) => p.byToken[tok.tokenHash] ?? 0}
                    name={tokenShortLabel(tok)}
                    stroke={tokenColor(i)}
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Per-token totals — a small table beneath the chart so it's clear
          which row maps to which line, and so the lifetime totals show
          even when current rolling rate is zero. */}
      {snap.data.tokens && snap.data.tokens.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Per-token usage</CardTitle>
            <CardDescription>
              Lifetime counters and rolling 60s rates for each of your tokens.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-dim border-b border-rule">
                    <th className="text-left font-medium py-2 pl-2">Token</th>
                    <th className="text-right font-medium py-2">Queries</th>
                    <th className="text-right font-medium py-2">Remembers</th>
                    <th className="text-right font-medium py-2">Forgets</th>
                    <th className="text-right font-medium py-2">Q/s</th>
                    <th className="text-right font-medium py-2 pr-2">R/s</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.data.tokens.map((tok, i) => (
                    <tr key={tok.tokenHash} className="border-b border-rule/40">
                      <td className="py-2 pl-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block h-2 w-3 rounded-sm"
                            style={{ background: tokenColor(i) }}
                          />
                          <span className="text-ink">{tokenShortLabel(tok)}</span>
                          <span className="text-[10px] text-faint font-mono">
                            {tok.tokenHash.slice(0, 8)}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink">
                        {fmtNumber(tok.counters.queries_total)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink">
                        {fmtNumber(tok.counters.remembers_total)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink">
                        {fmtNumber(tok.counters.forgets_total)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-dim">
                        {tok.rates.queries_per_sec_60s.toFixed(2)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-dim pr-2">
                        {tok.rates.remembers_per_sec_60s.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Hits per tier + Store sizes side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Hits per tier</CardTitle>
            <CardDescription>How much each tier contributed to fused results.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              { label: "Warm", icon: Flame, color: "bg-warn", hex: "#fbbf24", val: c.hits_warm_total },
              { label: "Cold", icon: Snowflake, color: "bg-accent", hex: "#7c9cff", val: c.hits_cold_total },
              { label: "Graph", icon: Network, color: "bg-graph", hex: "#4ade80", val: c.hits_graph_total },
            ].map((row) => {
              const Icon = row.icon;
              return (
                <div key={row.label}>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <div className="flex items-center gap-1.5 text-ink">
                      <Icon className="h-3.5 w-3.5" style={{ color: row.hex }} />
                      <span className="font-medium">{row.label}</span>
                    </div>
                    <div className="text-dim tabular-nums">
                      {fmtNumber(row.val)} <span className="text-faint">({pct(row.val).toFixed(0)}%)</span>
                    </div>
                  </div>
                  <div className="h-2 bg-subtle rounded-full overflow-hidden">
                    <div
                      className="h-full transition-all duration-300"
                      style={{ width: `${pct(row.val)}%`, backgroundColor: row.hex }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Store sizes</CardTitle>
            <CardDescription>
              {isAdmin ? "Live counts sampled at request time." : "Counts for your tenant only."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <StatCard label="Warm entries" value={fmtNumber(g.warm_entries)} icon={Flame} tone="warm" />
            <StatCard label="Cold entries" value={fmtNumber(g.cold_entries)} icon={Snowflake} tone="cold" />
            <StatCard
              label="Graph edges"
              value={g.graph_edges == null ? "—" : fmtNumber(g.graph_edges)}
              icon={Network}
              tone={g.graph_edges == null ? "default" : "graph"}
              sublabel={
                g.graph_edges == null
                  ? isAdmin
                    ? "graph unreachable"
                    : "tenant scope unavailable"
                  : undefined
              }
            />
            {adminGauges ? (
              <StatCard label="Orphans pending" value={fmtNumber(adminGauges.orphans_pending)} icon={Trash2} />
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Lifecycle counters — admin-only (decay/promotions are cross-tenant) */}
      {isAdminSnapshot(snap) ? (
        <Card>
          <CardHeader>
            <CardTitle>System lifecycle</CardTitle>
            <CardDescription>Memory transitions and cleanup events (cross-tenant).</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Remembers" value={fmtNumber(snap.data.counters.remembers_total)} icon={Zap} />
            <StatCard label="Forgets" value={fmtNumber(snap.data.counters.forgets_total)} icon={Trash2} />
            <StatCard label="Promotions" value={fmtNumber(snap.data.counters.promotions_total)} icon={ArrowUpToLine} tone="graph" />
            <StatCard label="Demotions" value={fmtNumber(snap.data.counters.demotions_total)} icon={ArrowDownToLine} tone="warm" />
            <StatCard label="Orphans reaped" value={fmtNumber(snap.data.counters.orphans_reaped_total)} icon={Trash2} />
          </CardContent>
        </Card>
      ) : null}
      </div>
    </>
  );
}

function SkeletonMetrics() {
  return (
    <>
      <PageHeader title="Metrics" subtitle="Loading…" />
      <div className="p-5 space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-4 animate-pulse">
              <div className="h-3 w-24 bg-subtle rounded mb-3" />
              <div className="h-7 w-16 bg-subtle rounded" />
            </Card>
          ))}
        </div>
        <Card className="h-64 animate-pulse" />
      </div>
    </>
  );
}
