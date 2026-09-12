import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ActivityEvent, NeighborsResult, SearchResult, api } from "../lib/api";
import { useActiveProject } from "../lib/active-project";
import { useAuth } from "../lib/auth-context";
import { KCard } from "../components/k/KCard";
import { KHeader } from "../components/k/KHeader";
import { KEmpty } from "../components/k/KEmpty";
import { KPill } from "../components/k/KPill";
import { KKbd } from "../components/k/KKbd";
import { KSignals } from "../components/k/KSignals";
import { cn } from "../lib/utils";

interface SearchResp {
  results: SearchResult[];
  degraded: boolean;
}
interface NeighborsResp {
  seed: string;
  results: NeighborsResult["neighbors"];
}
interface TodayResp {
  events: ActivityEvent[];
}

interface Props {
  /** The full list lives on Browse; Home links there rather than
   *  duplicating its filters, forget flow and pagination. */
  onBrowse: () => void;
}

/** The user's landing page: ask a question, see what answered it, and
 *  see what the memory has been doing today.
 *
 *  This is the one page whose reason to exist is the *fusion* result —
 *  the signal bars next to each hit are the only place the dashboard
 *  shows why an entry ranked where it did. */
export function HomePage({ onBrowse }: Props) {
  const { user } = useAuth();
  const { activeProjectId, activeProjectName } = useActiveProject();
  const includeProjects = activeProjectId ? [activeProjectId] : undefined;

  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 300);
  const isSearching = debounced.trim().length > 0;
  const [selected, setSelected] = useState<string | null>(null);

  const { data: searchResp, isFetching: searching } = useQuery({
    queryKey: ["home-search", debounced, activeProjectId ?? "global"],
    enabled: isSearching,
    queryFn: async () => {
      const r = await api<SearchResp>("POST", "/v1/search", {
        query: debounced,
        k: 8,
        ...(includeProjects ? { includeProjects } : {}),
      });
      if (!r.ok || !r.body) throw new Error(r.error ?? `search ${r.status}`);
      return r.body;
    },
  });

  const results = searchResp?.results ?? [];

  // Keep the neighbours panel pointed at something that still exists: a
  // new query replaces the result list, and a selection held over from
  // the previous one would fetch neighbours for an entry no longer shown.
  useEffect(() => {
    setSelected(results[0]?.id ?? null);
  }, [searchResp]);

  const { data: neighbors } = useQuery({
    queryKey: ["home-neighbors", selected, activeProjectId ?? "global"],
    enabled: !!selected,
    queryFn: async () => {
      const r = await api<NeighborsResp>("POST", "/v1/neighbors", {
        id: selected,
        depth: 1,
        k: 6,
        ...(includeProjects ? { includeProjects } : {}),
      });
      if (!r.ok || !r.body) throw new Error(r.error ?? `neighbors ${r.status}`);
      return r.body;
    },
  });

  const { data: today } = useQuery({
    queryKey: ["today"],
    queryFn: async () => {
      const r = await api<TodayResp>("GET", "/v1/me/today");
      if (!r.ok || !r.body) throw new Error(r.error ?? `today ${r.status}`);
      return r.body;
    },
    refetchInterval: 30_000,
  });

  const events = today?.events ?? [];

  return (
    <div className="p-6">
      <KHeader
        crumb={
          activeProjectName ? `project · ${activeProjectName}` : "global memory"
        }
        title={`Hello, ${user?.username ?? "there"}`}
        right={
          searchResp?.degraded ? (
            <KPill tone="warn" dot>
              degraded
            </KPill>
          ) : null
        }
      />

      {/* Ask */}
      <div className="mb-5 flex items-center gap-2.5 rounded-lg border border-rule bg-panel px-3.5 py-3 shadow-card focus-within:border-accent">
        <span className="font-mono text-sm text-faint">⌕</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask your memory…"
          aria-label="Search memory"
          className="flex-1 bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none"
        />
        {searching ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-faint border-t-transparent" />
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Results */}
        <div className="lg:col-span-2">
          <KCard
            title={isSearching ? `results · ${results.length}` : "results"}
            right={
              <button onClick={onBrowse} className="text-link hover:underline">
                browse all
              </button>
            }
          >
            {!isSearching ? (
              <KEmpty
                glyph="⌕"
                title="Ask a question"
                hint="Search runs keyword, vector and graph retrieval together and fuses the three. The bars next to each hit show what each one contributed."
              />
            ) : results.length === 0 && !searching ? (
              <KEmpty
                title="Nothing matched"
                hint={
                  activeProjectName
                    ? `Scoped to global memory and "${activeProjectName}". Switch the active project in the sidebar to widen it.`
                    : "Nothing in your global memory matched that."
                }
              />
            ) : (
              <div>
                {results.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelected(r.id)}
                    className={cn(
                      "flex w-full gap-4 border-b border-rule-soft px-4 py-3 text-left transition-colors last:border-0",
                      r.id === selected ? "bg-active" : "hover:bg-subtle/60"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] leading-relaxed text-ink">
                        {r.content}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-faint">
                        <KPill tone={r.tier === "warm" ? "warm" : "cold"}>
                          {r.tier}
                        </KPill>
                        <span>{r.namespace}</span>
                        {r.project ? <span>· {r.project}</span> : null}
                        <span>· {r.source}</span>
                        <span className="text-dim">· {r.score.toFixed(3)}</span>
                      </div>
                    </div>
                    <div className="w-32 shrink-0">
                      <KSignals signals={r.signals} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </KCard>
        </div>

        {/* Neighbours + today */}
        <div className="space-y-4">
          <KCard title="related">
            {!selected ? (
              <KEmpty
                glyph="✦"
                title="No entry selected"
                hint="Pick a result to see what it links to in the graph."
              />
            ) : (neighbors?.results ?? []).length === 0 ? (
              <KEmpty
                glyph="✦"
                title="No links yet"
                hint="Entities shared between entries build these links as the memory grows."
              />
            ) : (
              <div>
                {(neighbors?.results ?? []).map((n) => (
                  <div
                    key={n.id}
                    className="flex items-center gap-2 border-b border-rule-soft px-4 py-2 last:border-0"
                  >
                    <span
                      className={cn(
                        "font-mono text-[11px]",
                        n.tier === "warm" ? "text-warm" : "text-cold"
                      )}
                    >
                      {n.tier === "warm" ? "◉" : "○"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim">
                      {n.id}
                    </span>
                    <span className="font-mono text-[10.5px] text-faint tabular-nums">
                      {n.weight.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </KCard>

          <KCard title="today">
            {events.length === 0 ? (
              <KEmpty
                glyph="◷"
                title="Quiet so far"
                hint="Remembers, token mints and project changes appear here as they happen."
              />
            ) : (
              <div>
                {events.slice(0, 8).map((e, i) => (
                  <div
                    key={`${e.at}-${i}`}
                    className="flex items-start gap-2.5 border-b border-rule-soft px-4 py-2 last:border-0"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        e.kind === "remember"
                          ? "bg-graph"
                          : e.kind === "token"
                          ? "bg-accent"
                          : e.kind === "project"
                          ? "bg-cold"
                          : "bg-faint"
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-ink-2">
                        {e.text}
                      </div>
                      <div className="font-mono text-[10px] text-faint">
                        {new Date(e.at).toLocaleTimeString()}
                        {e.project ? ` · ${e.project}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </KCard>

          <div className="px-1 font-mono text-[10.5px] text-faint">
            press <KKbd>⌘K</KKbd> to jump anywhere
          </div>
        </div>
      </div>
    </div>
  );
}

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
