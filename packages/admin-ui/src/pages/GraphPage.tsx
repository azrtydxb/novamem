import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, RecentEntry } from "../lib/api";
import { useActiveProject } from "../lib/active-project";
import { KCard } from "../components/k/KCard";
import { KHeader } from "../components/k/KHeader";
import { KPill } from "../components/k/KPill";
import { KEmpty } from "../components/k/KEmpty";

interface RecentResp {
  results: RecentEntry[];
}
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
  useEffect(() => {
    setSeed(null);
  }, [activeProjectId]);

  const { data: recent } = useQuery({
    queryKey: ["graph-recent", activeProjectId ?? "global"],
    queryFn: async () => {
      const r = await api<RecentResp>("POST", "/v1/recent", {
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
      const r = await api<NeighborsResp>("POST", "/v1/neighbors", {
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
        tier: n.tier,
        x: 0.5 + Math.cos(angle) * 0.34,
        y: 0.5 + Math.sin(angle) * 0.34,
      };
    });
    const edges: Edge[] = ns.map((n) => ({
      from: seed,
      to: n.id,
      weight: n.score,
    }));
    return { nodes: [center, ...outer], edges };
  }, [seed, recent, neighborsResp]);

  return (
    <div className="p-6">
      <KHeader
        crumb={`neighbours · seed ${seed?.slice(0, 8) ?? "—"}`}
        title="Memory graph"
        right={
          <span className="font-mono text-[10.5px] text-faint">
            click a node to recenter
          </span>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <KCard title="subgraph · depth 1">
          {isFetching && nodes.length === 0 ? (
            <KEmpty glyph="◌" title="Loading graph…" />
          ) : nodes.length === 0 ? (
            <KEmpty
              glyph="✦"
              title="No memories to graph"
              hint="Remember something on the Browse page first — edges are built from entities entries share."
            />
          ) : (
            <GraphSvg
              nodes={nodes}
              edges={edges}
              seed={seed!}
              onSelect={setSeed}
            />
          )}
        </KCard>
        <Inspector seed={seed} nodes={nodes} edges={edges} />
      </div>
    </div>
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
          <stop
            offset="0%"
            stopColor="var(--color-accent)"
            stopOpacity="0.35"
          />
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
        // Fixed radius. This used to be 12 + hits*0.4, but /v1/recent
        // returns no hit count, so every node was drawn at 12 anyway and
        // the sizing only looked like it meant something.
        const r = 13;
        const isSeed = n.id === seed;
        const fill =
          n.tier === "warm" ? "var(--color-warm)" : "var(--color-cold)";
        return (
          <g
            key={n.id}
            style={{ cursor: "pointer" }}
            onClick={() => onSelect(n.id)}
          >
            {isSeed ? (
              <circle
                cx={n.x * W}
                cy={n.y * H}
                r={r * 3.5}
                fill="url(#seed-glow)"
              />
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
  const seedEdges = seed
    ? edges.filter((e) => e.from === seed || e.to === seed)
    : [];
  return (
    <KCard title="inspector">
      <div className="p-4">
        {node ? (
          <>
            <div className="text-[14px] font-medium text-ink">{node.label}</div>
            <div className="mt-0.5 font-mono text-[10.5px] text-dim">
              {node.id}
            </div>
            {/* "hits" was here, always reading 0: the endpoint behind
                this page does not return a hit count. A zero is a claim,
                not a blank. */}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <div className="font-mono text-[18px] font-bold text-ink tabular-nums">
                  {seedEdges.length}
                </div>
                <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-faint-2">
                  edges
                </div>
              </div>
            </div>
            <div className="mt-4 border-t border-rule-soft pt-4">
              <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-faint-2">
                tier
              </div>
              <KPill tone={node.tier === "warm" ? "warm" : "cold"}>
                {node.tier}
              </KPill>
            </div>
          </>
        ) : (
          <div className="text-[12.5px] text-dim">
            Pick a seed to inspect its neighbours.
          </div>
        )}
      </div>
    </KCard>
  );
}

function shortLabel(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 28 ? t.slice(0, 25) + "…" : t || "(empty)";
}
