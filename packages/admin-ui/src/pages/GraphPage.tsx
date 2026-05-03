import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, RecentEntry } from "../lib/api";
import { useActiveProject } from "../lib/active-project";
import { Card, CardContent } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";

interface RecentResp { results: RecentEntry[] }
interface NeighborsResp {
  seed: string;
  results: Array<{
    id: string;
    score: number;
    content: string;
    tier: "warm" | "cold";
    namespace: string;
    project: string | null;
    source: string;
    metadata: Record<string, unknown>;
    signals: { keyword: number; vector: number; graph: number };
  }>;
}

interface Node {
  id: string;
  label: string;
  hits: number;
  tier: "warm" | "cold";
  /** Normalised 0..1 layout coords. */
  x: number;
  y: number;
}

interface Edge {
  from: string;
  to: string;
  weight: number;
}

/** Memory graph visualisation. Picks the most-hit recent memory as the
 *  seed (or one chosen by the user via click) and asks the engine for
 *  its top-k neighbours. We lay nodes out on a circle around the seed —
 *  cheap, deterministic, and reads as a "neighbourhood" without pulling
 *  in a full force-layout library. */
export function GraphPage() {
  const [seed, setSeed] = useState<string | null>(null);
  const { activeProjectId } = useActiveProject();
  const includeProjects = activeProjectId ? [activeProjectId] : undefined;
  // Reset the seed when the user switches active project — the previous
  // seed may not be visible in the new scope.
  useEffect(() => { setSeed(null); }, [activeProjectId]);

  const { data: recent } = useQuery({
    queryKey: ["graph-recent", activeProjectId ?? "global"],
    queryFn: async () => {
      const r = await api<RecentResp>("POST", "/v1/me/recent", {
        k: 30,
        ...(includeProjects ? { includeProjects } : {}),
      });
      if (!r.ok || !r.body) throw new Error(r.error ?? `recent ${r.status}`);
      return r.body;
    },
  });

  useEffect(() => {
    if (!seed && recent && recent.results.length > 0) {
      setSeed(recent.results[0]!.id);
    }
  }, [recent, seed]);

  const { data: neighborsResp, isFetching } = useQuery({
    queryKey: ["graph-neighbors", seed, activeProjectId ?? "global"],
    queryFn: async () => {
      if (!seed) return { seed: "", results: [] };
      const r = await api<NeighborsResp>("POST", "/v1/me/neighbors", {
        id: seed,
        depth: 1,
        k: 6,
        ...(includeProjects ? { includeProjects } : {}),
      });
      if (!r.ok || !r.body) throw new Error(r.error ?? `neighbors ${r.status}`);
      return r.body;
    },
    enabled: !!seed,
  });

  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if (!seed) return { nodes: [], edges: [] };
    const center: Node = (() => {
      const e = recent?.results.find((r) => r.id === seed);
      return {
        id: seed,
        label: shortLabel(e?.content ?? seed),
        hits: e?.hits ?? 0,
        tier: e?.tier ?? "warm",
        x: 0.5,
        y: 0.5,
      };
    })();
    const ns = neighborsResp?.results ?? [];
    const outer: Node[] = ns.map((n, i) => {
      const angle = (i / Math.max(1, ns.length)) * Math.PI * 2 - Math.PI / 2;
      // Radius 0.34 in normalised space — keeps labels inside the SVG
      // viewBox at the configured 800×460 aspect.
      return {
        id: n.id,
        label: shortLabel(n.content),
        hits: 1,
        tier: n.tier,
        x: 0.5 + Math.cos(angle) * 0.34,
        y: 0.5 + Math.sin(angle) * 0.34,
      };
    });
    const edges: Edge[] = ns.map((n) => ({ from: seed, to: n.id, weight: n.score }));
    return { nodes: [center, ...outer], edges };
  }, [seed, recent, neighborsResp]);

  return (
    <>
      <PageHeader
        kicker={`Neighbours · seed ${seed?.slice(0, 8) ?? "—"}`}
        title="Memory graph"
        subtitle="Click any node to recenter the subgraph."
      />
      <div className="p-5 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3">
        <Card>
          <CardContent className="!p-0">
            {isFetching && nodes.length === 0 ? (
              <div className="text-center text-dim text-sm py-16">Loading graph…</div>
            ) : nodes.length === 0 ? (
              <div className="text-center py-16">
                <div className="font-mono text-[11px] text-faint mb-1">empty_graph</div>
                <div className="text-base font-medium text-ink mb-1">No memories to graph</div>
                <div className="text-sm text-dim">
                  Remember something on the Browse page first.
                </div>
              </div>
            ) : (
              <GraphSvg nodes={nodes} edges={edges} seed={seed!} onSelect={setSeed} />
            )}
          </CardContent>
        </Card>
        <Inspector seed={seed} nodes={nodes} edges={edges} />
      </div>
    </>
  );
}

function GraphSvg({
  nodes,
  edges,
  seed,
  onSelect,
}: {
  nodes: Node[];
  edges: Edge[];
  seed: string;
  onSelect: (id: string) => void;
}) {
  const W = 800;
  const H = 460;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full block">
      <defs>
        <radialGradient id="seed-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* Edges first so nodes paint over them. */}
      {edges.map((e, i) => {
        const a = nodes.find((n) => n.id === e.from);
        const b = nodes.find((n) => n.id === e.to);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x * W}
            y1={a.y * H}
            x2={b.x * W}
            y2={b.y * H}
            stroke="var(--color-dim)"
            strokeWidth={Math.max(1, e.weight * 1.6)}
            strokeOpacity={0.4}
          />
        );
      })}
      {nodes.map((n) => {
        const r = 12 + Math.min(20, n.hits * 0.4);
        const isSeed = n.id === seed;
        const fill = n.tier === "warm" ? "var(--color-warm)" : "var(--color-cold)";
        return (
          <g
            key={n.id}
            style={{ cursor: "pointer" }}
            onClick={() => onSelect(n.id)}
          >
            {isSeed ? (
              <circle cx={n.x * W} cy={n.y * H} r={r * 3.5} fill="url(#seed-glow)" />
            ) : null}
            <circle
              cx={n.x * W}
              cy={n.y * H}
              r={r}
              fill={fill}
              stroke="var(--color-panel)"
              strokeWidth={3}
            />
            <text
              x={n.x * W}
              y={n.y * H + r + 16}
              textAnchor="middle"
              fontSize="11"
              fontFamily="var(--font-sans)"
              fontWeight={500}
              fill="var(--color-ink)"
            >
              {n.label}
            </text>
            <text
              x={n.x * W}
              y={n.y * H + r + 28}
              textAnchor="middle"
              fontSize="9"
              fontFamily="var(--font-mono)"
              fill="var(--color-faint)"
            >
              {n.id.slice(0, 8)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Inspector({
  seed,
  nodes,
  edges,
}: {
  seed: string | null;
  nodes: Node[];
  edges: Edge[];
}) {
  const node = seed ? nodes.find((n) => n.id === seed) : null;
  const seedEdges = seed ? edges.filter((e) => e.from === seed || e.to === seed) : [];
  return (
    <Card>
      <div className="px-[18px] py-[14px] border-b border-rule-soft">
        <div className="text-sm font-semibold text-ink">Inspector</div>
      </div>
      <CardContent>
        {node ? (
          <>
            <div className="text-base font-semibold text-ink">{node.label}</div>
            <div className="font-mono text-[11px] text-dim mt-0.5">{node.id}</div>
            <div className="grid grid-cols-2 gap-3 mt-4">
              <div>
                <div className="text-lg font-semibold text-ink tabular-nums">{node.hits}</div>
                <div className="font-mono text-[9px] text-faint uppercase tracking-[0.06em]">
                  Hits
                </div>
              </div>
              <div>
                <div className="text-lg font-semibold text-ink tabular-nums">
                  {seedEdges.length}
                </div>
                <div className="font-mono text-[9px] text-faint uppercase tracking-[0.06em]">
                  Edges
                </div>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-rule-soft text-[12px]">
              <div className="font-mono text-dim mb-1">Tier</div>
              <Pill tone={node.tier === "warm" ? "warm" : "cold"}>{node.tier}</Pill>
            </div>
          </>
        ) : (
          <div className="text-sm text-dim">Pick a seed to inspect its neighbours.</div>
        )}
      </CardContent>
    </Card>
  );
}

function shortLabel(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 28 ? t.slice(0, 25) + "…" : t || "(empty)";
}
