import { useEffect, useState } from "react";
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
import { api } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import {
  METRICS_POLL_MS,
  isAdminSnapshot,
  useMetricsSnapshot,
} from "../lib/use-metrics";
import { Palette, seriesColors, usePalette } from "../lib/theme-colors";
import { KCard } from "../components/k/KCard";
import { KStat } from "../components/k/KStat";
import { KHeader } from "../components/k/KHeader";
import { KBtn } from "../components/k/KBtn";
import { KPill } from "../components/k/KPill";
import { KEmpty } from "../components/k/KEmpty";
import { useToast } from "../components/Toast";
import { fmtNumber, fmtRelative } from "../lib/utils";

const HISTORY_POINTS = 30; // 30 samples × 5s ≈ 2.5 minutes of data

interface HistoryPoint {
  t: number;
  qps: number;
  rps: number;
  /** Per-token qps keyed by tokenHash. Sparse — only tokens present in
   *  this snapshot have a value, so a freshly-revoked token leaves the
   *  chart cleanly instead of flatlining at zero. */
  byToken: Record<string, number>;
}

function tokenShortLabel(row: {
  tokenHash: string;
  label: string | null;
}): string {
  return row.label && row.label.trim() !== ""
    ? row.label
    : `token ${row.tokenHash.slice(0, 6)}`;
}

/** Recharts takes colours as props, so every one of them has to be a
 *  resolved value rather than a class. Grouped here so the whole chart
 *  follows a theme switch from one subscription. */
function chartTheme(p: Palette) {
  return {
    grid: p.grid || p.rule,
    axis: p.faint,
    tooltip: {
      background: p.panel,
      border: `1px solid ${p.rule}`,
      borderRadius: 6,
      fontSize: 12,
      color: p.ink,
    } as const,
  };
}

export function MetricsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const palette = usePalette();
  const theme = chartTheme(palette);
  const tokenColors = seriesColors(palette);

  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: snap, isFetching, refetch } = useMetricsSnapshot();

  // Append a chart point each time a snapshot lands.
  useEffect(() => {
    if (!snap) return;
    setHistory((cur) => {
      const last = cur[cur.length - 1];
      const t = Date.now();
      const byToken: Record<string, number> = {};
      for (const row of snap.data.tokens ?? [])
        byToken[row.tokenHash] = row.rates.queries_per_sec_60s;
      const point: HistoryPoint = {
        t,
        qps: snap.data.rates.queries_per_sec_60s,
        rps: snap.data.rates.remembers_per_sec_60s,
        byToken,
      };
      const out = last && t - last.t < 1000 ? cur : [...cur, point];
      return out.slice(-HISTORY_POINTS);
    });
  }, [snap]);

  const decay = useMutation({
    mutationFn: async () => {
      const r = await api<{ demoted: number; promoted: number }>(
        "POST",
        "/v1/decay",
        {}
      );
      if (!r.body) throw new Error("decay: empty body");
      return r.body;
    },
    onSuccess: (body) => {
      toast.success(
        "Decay run complete",
        `demoted ${body.demoted}, promoted ${body.promoted}`
      );
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
    onError: (err) => toast.error("Decay run failed", (err as Error).message),
  });

  if (!snap) return <SkeletonOverview />;

  const c = snap.data.counters;
  const g = snap.data.gauges;
  const adminData = isAdminSnapshot(snap) ? snap.data : null;
  const totalHits = c.hits_warm_total + c.hits_cold_total + c.hits_graph_total;
  const pct = (n: number) => (totalHits === 0 ? 0 : (n / totalHits) * 100);
  const tokens = snap.data.tokens ?? [];

  const tiers = [
    { label: "warm", value: c.hits_warm_total, color: palette.warm },
    { label: "cold", value: c.hits_cold_total, color: palette.cold },
    { label: "graph", value: c.hits_graph_total, color: palette.graph },
  ];

  return (
    <div className="p-6">
      <KHeader
        crumb={
          // The counters are deployment-wide — summed in Postgres — so
          // naming the replica is not a caveat about the numbers, only
          // useful when one pod is misbehaving.
          snap.data.instance
            ? `${isAdmin ? "operations" : "your activity"} · served by ${
                snap.data.instance
              }`
            : isAdmin
            ? "operations"
            : "your activity"
        }
        title="Overview"
        right={
          <>
            <KPill tone="graph" dot pulse>
              live · {METRICS_POLL_MS / 1000}s
            </KPill>
            <KBtn onClick={() => void refetch()} loading={isFetching}>
              Refresh
            </KBtn>
            {isAdmin ? (
              <KBtn
                variant="primary"
                onClick={() => decay.mutate()}
                loading={decay.isPending}
              >
                Run decay
              </KBtn>
            ) : null}
          </>
        }
      />

      {/* KPI row */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KStat
          label="queries / sec"
          value={fmtNumber(snap.data.rates.queries_per_sec_60s)}
          sub="rolling 60s"
          tone="accent"
          spark={history.map((p) => p.qps)}
          sparkColor={palette.accent}
        />
        <KStat
          label="remembers / sec"
          value={fmtNumber(snap.data.rates.remembers_per_sec_60s)}
          sub="rolling 60s"
          tone="graph"
          spark={history.map((p) => p.rps)}
          sparkColor={palette.graph}
        />
        <KStat
          label="total queries"
          value={fmtNumber(c.queries_total)}
          sub={`${fmtNumber(c.queries_zero_hit)} zero-hit`}
        />
        {adminData ? (
          <KStat
            label="last decay"
            value={
              adminData.gauges.last_decay_run_iso
                ? fmtRelative(adminData.gauges.last_decay_run_iso)
                : "never"
            }
            sub={`${fmtNumber(adminData.counters.decay_runs_total)} total runs`}
          />
        ) : (
          <KStat
            label="total remembers"
            value={fmtNumber(c.remembers_total)}
            sub={`${fmtNumber(c.forgets_total)} forgets`}
          />
        )}
      </div>

      {/* Live throughput */}
      <KCard
        className="mb-4"
        title={`throughput · last ${
          HISTORY_POINTS * (METRICS_POLL_MS / 1000)
        }s`}
        right={
          tokens.length > 0 ? (
            <span className="text-faint">dashed = per token</span>
          ) : null
        }
      >
        <div className="h-56 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={history}
              margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
            >
              <CartesianGrid stroke={theme.grid} strokeDasharray="2 4" />
              <XAxis
                dataKey="t"
                tickFormatter={(t) =>
                  new Date(t).toLocaleTimeString().slice(0, 5)
                }
                stroke={theme.axis}
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke={theme.axis}
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                contentStyle={theme.tooltip}
                labelFormatter={(t) =>
                  new Date(t as number).toLocaleTimeString()
                }
                formatter={(v) =>
                  typeof v === "number" ? v.toFixed(2) : String(v ?? "")
                }
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
              <Line
                type="monotone"
                dataKey="qps"
                name="queries/s"
                stroke={palette.accent}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="rps"
                name="remembers/s"
                stroke={palette.graph}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              {tokens.map((tok, i) => (
                <Line
                  key={tok.tokenHash}
                  type="monotone"
                  dataKey={(p: HistoryPoint) => p.byToken[tok.tokenHash] ?? 0}
                  name={tokenShortLabel(tok)}
                  stroke={tokenColors[i % tokenColors.length]}
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </KCard>

      <PersistentThroughputChart />

      {tokens.length > 0 ? (
        <KCard className="mt-4" title="per-token usage">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  {[
                    "token",
                    "queries",
                    "remembers",
                    "forgets",
                    "q/s",
                    "r/s",
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={`px-4 py-2 font-mono text-[9.5px] font-normal uppercase tracking-[0.14em] text-faint-2 ${
                        i === 0 ? "" : "text-right"
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tokens.map((tok, i) => (
                  <tr
                    key={tok.tokenHash}
                    className="border-b border-rule-soft last:border-0"
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-block h-2 w-3 rounded-sm"
                          style={{
                            background: tokenColors[i % tokenColors.length],
                          }}
                        />
                        <span className="text-[12.5px] text-ink">
                          {tokenShortLabel(tok)}
                        </span>
                        <span className="font-mono text-[10px] text-faint">
                          {tok.tokenHash.slice(0, 8)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-ink tabular-nums">
                      {fmtNumber(tok.counters.queries_total)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-ink tabular-nums">
                      {fmtNumber(tok.counters.remembers_total)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-ink tabular-nums">
                      {fmtNumber(tok.counters.forgets_total)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-dim tabular-nums">
                      {tok.rates.queries_per_sec_60s.toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-dim tabular-nums">
                      {tok.rates.remembers_per_sec_60s.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </KCard>
      ) : null}

      {/* Hits per tier + stores */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <KCard
          title="hits per tier"
          right={
            <span className="text-faint">
              {totalHits === 0
                ? "no hits yet"
                : `${fmtNumber(totalHits)} total`}
            </span>
          }
        >
          <div className="space-y-3.5 p-4">
            {tiers.map((row) => (
              <div key={row.label}>
                <div className="mb-1.5 flex items-center justify-between font-mono text-[11px]">
                  <span className="lowercase text-ink-2">{row.label}</span>
                  <span className="text-dim tabular-nums">
                    {fmtNumber(row.value)}{" "}
                    <span className="text-faint">
                      ({pct(row.value).toFixed(0)}%)
                    </span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-sm bg-subtle-2">
                  <div
                    className="h-full transition-[width] duration-300"
                    style={{
                      width: `${pct(row.value)}%`,
                      backgroundColor: row.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </KCard>

        <KCard title={isAdmin ? "stores" : "your stores"}>
          <div className="grid grid-cols-2 gap-3 p-4">
            <KStat
              label="warm entries"
              value={fmtNumber(g.warm_entries)}
              tone="warm"
            />
            <KStat
              label="cold entries"
              value={fmtNumber(g.cold_entries)}
              tone="cold"
            />
            <KStat
              label="graph edges"
              value={g.graph_edges == null ? "—" : fmtNumber(g.graph_edges)}
              tone={g.graph_edges == null ? undefined : "graph"}
              sub={
                g.graph_edges == null
                  ? isAdmin
                    ? "graph unreachable"
                    : "user scope unavailable"
                  : undefined
              }
            />
            {adminData ? (
              <KStat
                label="orphans pending"
                value={fmtNumber(adminData.gauges.orphans_pending)}
              />
            ) : null}
          </div>
        </KCard>
      </div>

      {/* Lifecycle — admin only: decay and promotions are cross-user. */}
      {adminData ? (
        <KCard className="mt-4" title="system lifecycle">
          <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-5">
            <KStat
              label="remembers"
              value={fmtNumber(adminData.counters.remembers_total)}
            />
            <KStat
              label="forgets"
              value={fmtNumber(adminData.counters.forgets_total)}
            />
            <KStat
              label="promotions"
              value={fmtNumber(adminData.counters.promotions_total)}
              tone="graph"
            />
            <KStat
              label="demotions"
              value={fmtNumber(adminData.counters.demotions_total)}
              tone="warm"
            />
            <KStat
              label="orphans reaped"
              value={fmtNumber(adminData.counters.orphans_reaped_total)}
            />
          </div>
        </KCard>
      ) : null}
    </div>
  );
}

function SkeletonOverview() {
  return (
    <div className="p-6">
      <KHeader crumb="operations" title="Overview" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="animate-pulse rounded-lg border border-rule bg-panel px-4 py-3"
          >
            <div className="mb-3 h-3 w-24 rounded bg-subtle" />
            <div className="h-6 w-16 rounded bg-subtle" />
          </div>
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg border border-rule bg-panel" />
    </div>
  );
}

interface HistorySample {
  sampledAt: string;
  queries: number;
  remembers: number;
}

interface HistoryResp {
  hours: number;
  samples: HistorySample[];
}

/** 24h persistent throughput, from the metrics_samples table. Survives
 *  reboots; the live chart above only holds the last few minutes. */
function PersistentThroughputChart() {
  const palette = usePalette();
  const theme = chartTheme(palette);
  const { data, isFetching } = useQuery<HistoryResp>({
    queryKey: ["me", "metrics", "history"],
    queryFn: async () => {
      const r = await api<HistoryResp>(
        "GET",
        "/v1/me/metrics/history?hours=24"
      );
      if (!r.ok || !r.body) throw new Error(r.error ?? `history ${r.status}`);
      return r.body;
    },
    refetchInterval: 60_000,
  });

  const points = (data?.samples ?? []).map((s) => ({
    t: new Date(s.sampledAt).getTime(),
    queries: s.queries,
    remembers: s.remembers,
  }));
  const totalQueries = points.reduce((a, p) => a + p.queries, 0);
  const totalRemembers = points.reduce((a, p) => a + p.remembers, 0);

  return (
    <KCard
      title="24h history"
      right={
        <span className="text-faint">
          {isFetching ? "refreshing… " : ""}
          {points.length > 0
            ? `${fmtNumber(totalQueries)} queries · ${fmtNumber(
                totalRemembers
              )} remembers`
            : null}
        </span>
      }
    >
      {points.length === 0 ? (
        <KEmpty
          glyph="◷"
          title="No activity recorded yet"
          hint="Samples are written once a minute and persisted, so this fills in as the deployment is used — and survives a restart."
        />
      ) : (
        <div className="h-56 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={points}
              margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
            >
              <CartesianGrid stroke={theme.grid} strokeDasharray="2 4" />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => {
                  const d = new Date(t);
                  return `${d.getHours().toString().padStart(2, "0")}:${d
                    .getMinutes()
                    .toString()
                    .padStart(2, "0")}`;
                }}
                stroke={theme.axis}
                fontSize={11}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                stroke={theme.axis}
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={32}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={theme.tooltip}
                labelFormatter={(t) => new Date(t as number).toLocaleString()}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
              <Line
                type="monotone"
                dataKey="queries"
                name="queries/min"
                stroke={palette.accent}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="remembers"
                name="remembers/min"
                stroke={palette.graph}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </KCard>
  );
}
