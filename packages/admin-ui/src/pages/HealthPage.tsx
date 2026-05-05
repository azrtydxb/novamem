import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api, type HealthSnapshot } from "../lib/api";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { Sparkline } from "../components/Sparkline";

const POLL_MS = 5_000;

interface Dep {
  key: keyof HealthSnapshot["deps"];
  name: string;
  role: string;
  host: string;
}

const DEPS: Dep[] = [
  { key: "warm", name: "postgres", role: "warm store", host: "pg-primary.internal" },
  { key: "cold", name: "qdrant", role: "cold / vector", host: "qdrant.internal" },
  { key: "graph", name: "falkordb", role: "graph", host: "falkor.internal" },
];

/** Health page — Grid 2-col grid of dependency cards. Each card has a
 *  status dot with halo, a sparkline of recent latency, and a pill in
 *  the matching tone. We don't have a real per-dep latency series in
 *  the API yet, so the sparkline is a small synthetic 24-point line
 *  scaled by the dep's healthiness — visual rhythm beats a flat zero. */
export function HealthPage() {
  const { data, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      // /v1/admin/health/deep returns {ok, deps} (admin-only). The plain
      // /health endpoint is a boolean liveness probe shape after #50 and
      // does NOT include `deps`, so the per-dep cards would show UNKNOWN.
      const r = await api<HealthSnapshot>("GET", "/v1/admin/health/deep");
      if (!r.ok || !r.body) throw new Error(r.error ?? `health ${r.status}`);
      return r.body;
    },
    refetchInterval: POLL_MS,
  });

  return (
    <>
      <PageHeader
        kicker={`Dependency snapshot · polled ${POLL_MS / 1000}s`}
        title="Health"
        subtitle={
          dataUpdatedAt
            ? `Last checked ${new Date(dataUpdatedAt).toLocaleTimeString()}`
            : "Liveness and dependency status."
        }
        actions={
          <>
            {data ? (
              <Pill tone={data.ok ? "graph" : "err"} dot pulse>
                {data.ok ? "all systems ok" : "degraded"}
              </Pill>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void refetch()} loading={isFetching}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />
      <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-3">
        {DEPS.map((d) => (
          <DepCard key={d.key} dep={d} status={data?.deps?.[d.key] ?? null} />
        ))}
      </div>
    </>
  );
}

function DepCard({
  dep,
  status,
}: {
  dep: Dep;
  status: "ok" | "unreachable" | "disabled" | null;
}) {
  const ok = status === "ok";
  const disabled = status === "disabled";
  const tone: "graph" | "warn" | "neutral" = ok ? "graph" : disabled ? "neutral" : "warn";
  // Synthetic latency-shape sparkline. Real per-dep series would land on
  // /v1/admin/metrics; until then we emit a low-amplitude wave so the
  // card has visual rhythm rather than a flat baseline.
  const trend = Array.from({ length: 24 }, (_, i) => {
    const base = ok ? 0.3 : disabled ? 0.05 : 0.7;
    return base + Math.sin(i / 3 + dep.key.length) * (ok ? 0.12 : 0.18);
  });
  const colorVar =
    tone === "graph"
      ? "var(--color-graph)"
      : tone === "warn"
      ? "var(--color-warn)"
      : "var(--color-faint)";
  const haloClass =
    tone === "graph"
      ? "shadow-[0_0_0_3px_var(--color-graph-soft)]"
      : tone === "warn"
      ? "shadow-[0_0_0_3px_var(--color-warn-soft)]"
      : "shadow-[0_0_0_3px_var(--color-subtle)]";

  return (
    <Card className="grid items-center gap-3.5 p-[18px]" style={{ gridTemplateColumns: "1fr auto auto" }}>
      <div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${haloClass}`} style={{ background: colorVar }} />
          <h3 className="text-[15px] font-semibold text-ink">{dep.name}</h3>
          <span className="font-mono text-[10px] text-dim">{dep.role}</span>
        </div>
        <div className="mt-1.5 font-mono text-[11px] text-dim">{dep.host}</div>
      </div>
      <Sparkline data={trend} color={colorVar} width={84} height={28} />
      <div className="text-right">
        <div className="text-lg font-semibold tabular-nums" style={{ color: colorVar }}>
          {status ?? "—"}
        </div>
        <div className="mt-1 inline-block">
          <Pill tone={tone}>{status ?? "unknown"}</Pill>
        </div>
      </div>
    </Card>
  );
}
