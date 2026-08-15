import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api, type HealthSnapshot } from "../lib/api";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";

const POLL_MS = 5_000;

interface Dep {
  key: keyof HealthSnapshot["deps"];
  name: string;
  role: string;
}

/** Cards are derived from what the server reports, not from a fixed
 *  list. The fixed list claimed three dependencies: postgres, "qdrant"
 *  and "falkordb", each with an invented hostname. Two of those were
 *  wrong — the cold tier is whichever backend is configured (this
 *  deployment runs pgvector) and there has been no graph service for a
 *  long time, so an operator was shown a retired product sitting at
 *  "falkor.internal" as though it were part of the stack. The embedder,
 *  which the server does report and which genuinely can fail, was not
 *  shown at all. */
function depsOf(data: HealthSnapshot | undefined): Dep[] {
  return [
    { key: "warm", name: "postgres", role: "warm store" },
    { key: "cold", name: data?.coldProvider ?? "vector store", role: "cold / vector" },
    { key: "embedder", name: "embeddings", role: "embedding service" },
  ];
}

/** Health page — Grid 2-col grid of dependency cards. Each card has a
 *  status dot with halo and a pill in the matching tone. We intentionally
 *  do not render latency/trend charts until the API exposes real per-dep
 *  series; decorative fake telemetry misleads operators. */
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
        {depsOf(data).map((d) => (
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
  status: "ok" | "unreachable" | "disabled" | "failing" | null;
}) {
  const ok = status === "ok";
  const disabled = status === "disabled";
  const tone: "graph" | "warn" | "neutral" = ok ? "graph" : disabled ? "neutral" : "warn";
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
    <Card className="grid items-center gap-3.5 p-[18px]" style={{ gridTemplateColumns: "1fr auto" }}>
      <div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${haloClass}`} style={{ background: colorVar }} />
          <h3 className="text-[15px] font-semibold text-ink">{dep.name}</h3>
          <span className="font-mono text-[10px] text-dim">{dep.role}</span>
        </div>
      </div>
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
