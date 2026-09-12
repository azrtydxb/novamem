import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type HealthSnapshot } from "../lib/api";
import { KCard } from "../components/k/KCard";
import { KHeader } from "../components/k/KHeader";
import { KBtn } from "../components/k/KBtn";
import { KPill } from "../components/k/KPill";
import { KSpark } from "../components/k/KSpark";
import { usePalette } from "../lib/theme-colors";
import { cn } from "../lib/utils";

const POLL_MS = 5_000;
/** Roughly two minutes of polls. */
const TRACE_POINTS = 24;

type DepStatus = "ok" | "unreachable" | "disabled" | "failing";

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
  const deps: Dep[] = [{ key: "warm", name: "postgres", role: "warm store" }];
  // No cold tier means no card. The server reports `cold: "ok"` when
  // none is configured — there is nothing to be unreachable — so a card
  // here would assert a healthy dependency that does not exist, which is
  // the same class of lie this page was fixed for. Naming it "none"
  // would just read as a service called none.
  if (data?.coldProvider !== "none") {
    deps.push({
      key: "cold",
      name: data?.coldProvider ?? "vector store",
      role: "cold / vector",
    });
  }
  deps.push({ key: "embedder", name: "embeddings", role: "embedding service" });
  return deps;
}

/** Health — one card per dependency the server actually reports.
 *
 *  The v2 design draws a latency figure and a trend line on each card.
 *  There is no per-dependency latency in the payload, and inventing one
 *  is the exact failure this page was fixed for in #238. What the
 *  sparkline plots instead is real and is labelled for what it is: the
 *  statuses *this browser* has observed since the page opened, one point
 *  per poll. It is not server history, and it resets on reload. */
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

  const trace = useObservedTrace(data, dataUpdatedAt);
  const deps = depsOf(data);

  return (
    <div className="p-6">
      <KHeader
        crumb={`dependency snapshot · polled ${POLL_MS / 1000}s`}
        title="Health"
        right={
          <>
            {data ? (
              <KPill tone={data.ok ? "graph" : "err"} dot pulse>
                {data.ok ? "all systems ok" : "degraded"}
              </KPill>
            ) : null}
            <KBtn onClick={() => void refetch()} loading={isFetching}>
              Refresh
            </KBtn>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {deps.map((d) => (
          <DepCard
            key={d.key}
            dep={d}
            status={data?.deps?.[d.key] ?? null}
            trace={trace[d.key] ?? []}
          />
        ))}
      </div>

      <div className="mt-3 font-mono text-[10.5px] text-faint">
        {dataUpdatedAt
          ? `last checked ${new Date(dataUpdatedAt).toLocaleTimeString()}`
          : "waiting for the first check…"}
        {" · "}
        traces are what this browser has observed since the page opened
      </div>
    </div>
  );
}

/** Rolling per-dependency history of observed statuses.
 *
 *  Keyed off `dataUpdatedAt` rather than `data`: a poll that returns an
 *  identical snapshot gives the same object identity from the cache, and
 *  an effect on `data` alone would record nothing while the deployment
 *  was steady — which is exactly when the trace should be a flat line. */
function useObservedTrace(
  data: HealthSnapshot | undefined,
  dataUpdatedAt: number
): Partial<Record<Dep["key"], number[]>> {
  const [trace, setTrace] = useState<Partial<Record<Dep["key"], number[]>>>({});
  const lastAt = useRef(0);

  useEffect(() => {
    if (!data || !dataUpdatedAt || dataUpdatedAt === lastAt.current) return;
    lastAt.current = dataUpdatedAt;
    setTrace((cur) => {
      const next = { ...cur };
      for (const key of Object.keys(data.deps) as Array<Dep["key"]>) {
        const point = data.deps[key] === "ok" ? 1 : 0;
        next[key] = [...(cur[key] ?? []), point].slice(-TRACE_POINTS);
      }
      return next;
    });
  }, [data, dataUpdatedAt]);

  return trace;
}

function DepCard({
  dep,
  status,
  trace,
}: {
  dep: Dep;
  status: DepStatus | null;
  trace: number[];
}) {
  const palette = usePalette();
  const ok = status === "ok";
  const disabled = status === "disabled";
  const tone: "graph" | "warn" | "dim" = ok
    ? "graph"
    : disabled
    ? "dim"
    : "warn";
  const color =
    tone === "graph"
      ? palette.graph
      : tone === "warn"
      ? palette.warn
      : palette.faint;

  // A trace that has never left "ok" is a flat line at 1; a dip is the
  // only thing worth looking at, so it is drawn only once there is one.
  const everFailed = trace.some((p) => p === 0);

  return (
    <KCard
      title={dep.name}
      right={<KPill tone={tone}>{status ?? "unknown"}</KPill>}
    >
      <div className="flex items-center gap-4 p-4">
        <span
          aria-hidden
          className={cn(
            "h-2.5 w-2.5 shrink-0 rounded-full",
            tone === "graph"
              ? "shadow-[0_0_0_3px_var(--color-graph-soft)]"
              : tone === "warn"
              ? "shadow-[0_0_0_3px_var(--color-warn-soft)]"
              : "shadow-[0_0_0_3px_var(--color-subtle)]"
          )}
          style={{ background: color }}
        />
        <div className="min-w-0 flex-1">
          <div
            className="font-mono text-[18px] font-bold lowercase tabular-nums"
            style={{ color }}
          >
            {status ?? "—"}
          </div>
          <div className="font-mono text-[10.5px] text-faint">{dep.role}</div>
        </div>
        <div className="shrink-0 text-right">
          {trace.length > 1 ? (
            <>
              <KSpark data={trace} color={color} fill={everFailed} />
              <div className="mt-0.5 font-mono text-[9.5px] text-faint-2">
                {trace.length} polls
              </div>
            </>
          ) : (
            <span className="font-mono text-[9.5px] text-faint-2">
              collecting…
            </span>
          )}
        </div>
      </div>
    </KCard>
  );
}
