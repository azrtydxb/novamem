import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
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
import { Badge } from "../components/Badge";
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
  const endpoint = isAdmin ? "/v1/admin/metrics" : "/v1/me/metrics";

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
      const point: HistoryPoint = {
        t,
        qps: snap.data.rates.queries_per_sec_60s,
        rps: snap.data.rates.remembers_per_sec_60s,
        warmHits: prev ? snap.data.counters.hits_warm_total - prev.hits_warm_total : 0,
        coldHits: prev ? snap.data.counters.hits_cold_total - prev.hits_cold_total : 0,
        graphHits: prev ? snap.data.counters.hits_graph_total - prev.hits_graph_total : 0,
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
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-text">Metrics</h1>
            {!isAdmin && user?.tenantId ? (
              <Badge tone="accent">tenant: {user.tenantId}</Badge>
            ) : null}
          </div>
          <p className="text-sm text-text-muted mt-1">
            {isAdmin
              ? "Operational counters, gauges, and rates. In-memory; resets on restart."
              : "Activity for your tenant only. In-memory; resets on restart."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={load} loading={busy}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
          {isAdmin ? (
            <Button size="sm" variant="secondary" onClick={runDecay} loading={decayBusy}>
              <ArrowDownToLine className="h-3.5 w-3.5" /> Run decay
            </Button>
          ) : null}
        </div>
      </header>

      {/* Top: rolling rates + uptime */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Search}
          label="Queries / sec"
          value={fmtNumber(snap.data.rates.queries_per_sec_60s)}
          sublabel="rolling 60s"
        />
        <StatCard
          icon={Zap}
          label="Remembers / sec"
          value={fmtNumber(snap.data.rates.remembers_per_sec_60s)}
          sublabel="rolling 60s"
        />
        <StatCard
          icon={Activity}
          label="Total queries"
          value={fmtNumber(c.queries_total)}
          sublabel={`${fmtNumber(c.queries_zero_hit)} zero-hit`}
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

      {/* Activity chart */}
      <Card>
        <CardHeader>
          <CardTitle>Throughput</CardTitle>
          <CardDescription>Queries and remembers per second, last {HISTORY_POINTS * (POLL_MS / 1000)}s.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="qps" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#7c9cff" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#7c9cff" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="rps" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4ade80" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#4ade80" stopOpacity={0} />
                  </linearGradient>
                </defs>
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
                  formatter={(v: number) => v.toFixed(2)}
                />
                <Area
                  type="monotone"
                  dataKey="qps"
                  name="queries/s"
                  stroke="#7c9cff"
                  strokeWidth={2}
                  fill="url(#qps)"
                />
                <Area
                  type="monotone"
                  dataKey="rps"
                  name="remembers/s"
                  stroke="#4ade80"
                  strokeWidth={2}
                  fill="url(#rps)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Hits per tier + Store sizes side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Hits per tier</CardTitle>
            <CardDescription>How much each tier contributed to fused results.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              { label: "Warm", icon: Flame, color: "bg-warning", hex: "#fbbf24", val: c.hits_warm_total },
              { label: "Cold", icon: Snowflake, color: "bg-accent", hex: "#7c9cff", val: c.hits_cold_total },
              { label: "Graph", icon: Network, color: "bg-success", hex: "#4ade80", val: c.hits_graph_total },
            ].map((row) => {
              const Icon = row.icon;
              return (
                <div key={row.label}>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <div className="flex items-center gap-1.5 text-text">
                      <Icon className="h-3.5 w-3.5" style={{ color: row.hex }} />
                      <span className="font-medium">{row.label}</span>
                    </div>
                    <div className="text-text-muted tabular-nums">
                      {fmtNumber(row.val)} <span className="text-text-subtle">({pct(row.val).toFixed(0)}%)</span>
                    </div>
                  </div>
                  <div className="h-2 bg-bg-subtle rounded-full overflow-hidden">
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
            <StatCard label="Warm entries" value={fmtNumber(g.warm_entries)} icon={Flame} tone="warning" />
            <StatCard label="Cold entries" value={fmtNumber(g.cold_entries)} icon={Snowflake} tone="accent" />
            <StatCard
              label="Graph edges"
              value={g.graph_edges == null ? "—" : fmtNumber(g.graph_edges)}
              icon={Network}
              tone={g.graph_edges == null ? "default" : "success"}
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
            <StatCard label="Promotions" value={fmtNumber(snap.data.counters.promotions_total)} icon={ArrowUpToLine} tone="success" />
            <StatCard label="Demotions" value={fmtNumber(snap.data.counters.demotions_total)} icon={ArrowDownToLine} tone="warning" />
            <StatCard label="Orphans reaped" value={fmtNumber(snap.data.counters.orphans_reaped_total)} icon={Trash2} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SkeletonMetrics() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">Metrics</h1>
        <p className="text-sm text-text-muted mt-1">Loading…</p>
      </header>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-4 animate-pulse">
            <div className="h-3 w-24 bg-bg-subtle rounded mb-3" />
            <div className="h-7 w-16 bg-bg-subtle rounded" />
          </Card>
        ))}
      </div>
      <Card className="h-64 animate-pulse" />
    </div>
  );
}
