import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, RecentEntry, RememberResult, SearchResult } from "../lib/api";
import { useActiveProject } from "../lib/active-project";
import { KCard } from "../components/k/KCard";
import { KHeader } from "../components/k/KHeader";
import { KBtn } from "../components/k/KBtn";
import { KPill } from "../components/k/KPill";
import { KEmpty } from "../components/k/KEmpty";
import { KSignals } from "../components/k/KSignals";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { cn } from "../lib/utils";

/** What a row can carry.
 *
 *  The two endpoints behind this page return different shapes.
 *  `/v1/search` ranks, so every hit has `signals`. `/v1/recent` orders
 *  by recency and computes no ranking at all — no `signals`, and none of
 *  the `hits` / `age` / `decay` the v2 design draws on a row.
 *
 *  So `signals` is optional here and the row renders the bars only when
 *  they exist. Passing an absent `signals` into KSignals threw; showing
 *  three empty bars instead would be the other failure — a bar at zero
 *  claims a signal contributed nothing, not that nothing computed it. */
type Row = Omit<SearchResult, "signals"> &
  Partial<Pick<SearchResult, "signals">>;

interface RecentResp {
  results: RecentEntry[];
}
interface SearchResp {
  results: SearchResult[];
  degraded: boolean;
}

type TierFilter = "all" | "warm" | "cold";

/** Browse memories — `/v1/recent` by default, `/v1/search` once the user
 *  types. Both return the same row shape for the fields they share. */
interface BrowseProps {
  /** Set when the user arrived by picking a memory in the ⌘K palette:
   *  the query that found it, and the row to open. */
  seed?: { query: string; id: string } | null;
}

export function BrowsePage({ seed }: BrowseProps = {}) {
  const [query, setQuery] = useState(seed?.query ?? "");
  // Debounce input: render after 300ms of typing inactivity to avoid
  // thrashing the search backend on every keystroke.
  const debounced = useDebounced(query, 300);
  const isSearching = debounced.trim().length > 0;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmForget, setConfirmForget] = useState<Row | null>(null);
  const [tier, setTier] = useState<TierFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(seed?.id ?? null);

  // A later pick from the palette re-seeds a page that is already open.
  useEffect(() => {
    if (!seed) return;
    setQuery(seed.query);
    setExpanded(seed.id);
  }, [seed]);
  const { activeProjectId, activeProjectName } = useActiveProject();
  // Active-project mode: union the user-global view with the selected
  // project so Browse shows both side-by-side. The query key includes
  // the id so React Query refetches whenever the user switches projects.
  const includeProjects = activeProjectId ? [activeProjectId] : undefined;

  const { data: recent, isFetching: recentLoading } = useQuery({
    queryKey: ["browse-recent", activeProjectId ?? "global"],
    queryFn: async () => {
      const r = await api<RecentResp>("POST", "/v1/recent", {
        k: 20,
        ...(includeProjects ? { includeProjects } : {}),
      });
      if (!r.ok || !r.body) throw new Error(r.error ?? `recent ${r.status}`);
      return r.body;
    },
    enabled: !isSearching,
  });

  const { data: searchResp, isFetching: searchLoading } = useQuery({
    queryKey: ["browse-search", debounced, activeProjectId ?? "global"],
    queryFn: async () => {
      const r = await api<SearchResp>("POST", "/v1/search", {
        query: debounced,
        k: 20,
        ...(includeProjects ? { includeProjects } : {}),
      });
      if (!r.ok || !r.body) throw new Error(r.error ?? `search ${r.status}`);
      return r.body;
    },
    enabled: isSearching,
  });

  const all: Row[] = isSearching
    ? searchResp?.results ?? []
    : recent?.results ?? [];
  const loading = isSearching ? searchLoading : recentLoading;

  const tierCounts = useMemo(() => {
    let warm = 0;
    let cold = 0;
    for (const r of all) {
      if (r.tier === "warm") warm++;
      else cold++;
    }
    return { warm, cold };
  }, [all]);

  const results = tier === "all" ? all : all.filter((r) => r.tier === tier);

  const [composing, setComposing] = useState(false);
  const [newContent, setNewContent] = useState("");
  const remember = useMutation({
    mutationFn: async () => {
      // Writes follow the active scope: when a project is active, store
      // the new memory inside it; otherwise it's user-global.
      const r = await api<RememberResult>("POST", "/v1/remember", {
        content: newContent.trim(),
        ...(activeProjectId ? { project: activeProjectId } : {}),
      });
      if (!r.ok) throw new Error(r.error ?? `remember ${r.status}`);
      return r.body;
    },
    onSuccess: (body) => {
      // A 201 does not mean an entry was written. The engine answers
      // `{id: null, rejected: "<reason>"}` for content it will not keep
      // (too short to be durable knowledge, over the length cap), and
      // flags a write that merged into an existing entry rather than
      // creating one. Calling all of those "Memory stored" tells the
      // user something is in their memory when nothing is — the same
      // failure the forget flow was fixed for with `deleted: false`.
      if (body?.rejected) {
        toast.error("Not stored", body.rejected);
        // The composer stays open holding the text, so the user can
        // expand it rather than retype it.
        return;
      }
      const scope = activeProjectName
        ? `Added to "${activeProjectName}".`
        : "Added to your memory.";
      if (body?.deduplicated) {
        toast.success(
          "Already remembered",
          "An entry with this content exists — nothing new was written."
        );
      } else if (body?.updated) {
        toast.success(
          "Existing memory updated",
          body.superseded?.length
            ? `Superseded ${body.superseded.length} earlier ${
                body.superseded.length === 1 ? "entry" : "entries"
              }.`
            : "The write merged into an entry you already had."
        );
      } else if (body?.embedded === false) {
        // Stored, but searchable by keyword only until it is embedded.
        toast.success(
          "Memory stored without a vector",
          `${scope} The embedder did not answer, so this entry will not match by similarity yet.`
        );
      } else {
        toast.success("Memory stored", scope);
      }
      setComposing(false);
      setNewContent("");
      void queryClient.invalidateQueries({ queryKey: ["browse-recent"] });
    },
    onError: (err) => toast.error("Failed to remember", (err as Error).message),
  });

  // Deleting a memory was API- and MCP-only: /v1/forget has always
  // existed, and the dashboard that shows every entry had no way to
  // remove one. A reader could see a memory they wanted gone and had to
  // leave the UI to do it.
  const forget = useMutation({
    mutationFn: async (entry: Row) => {
      // The row's OWN project, not the active scope. Browse shows a
      // union of user-global and active-project entries, so deleting a
      // project-scoped row while globally scoped would look up an id the
      // server cannot see and answer `deleted: false` — a success toast
      // over a memory that is still there.
      const r = await api<{ deleted: boolean; coldDeleteOk?: boolean }>(
        "POST",
        "/v1/forget",
        { id: entry.id, ...(entry.project ? { project: entry.project } : {}) }
      );
      if (!r.ok) throw new Error(r.error ?? `forget ${r.status}`);
      return r.body;
    },
    onSuccess: (body) => {
      // `deleted: false` is a 200: the row was not found in the caller's
      // scope. Reporting that as success is how a memory appears to be
      // deleted and comes back on the next refresh.
      if (!body?.deleted) {
        toast.error(
          "Nothing was deleted",
          "The entry was not found in your scope — it may already be gone."
        );
      } else if (body.coldDeleteOk === false) {
        // The warm row is gone but the vector or a derived fact survived.
        // Saying "all gone" here makes a partial cleanup look complete.
        toast.success(
          "Memory forgotten, vector left behind",
          "The entry is deleted; its cold-tier copy could not be removed and will be reaped."
        );
      } else {
        toast.success("Memory forgotten", "The entry and its vector are gone.");
      }
      setConfirmForget(null);
      void queryClient.invalidateQueries({ queryKey: ["browse-recent"] });
      void queryClient.invalidateQueries({ queryKey: ["browse-search"] });
    },
    onError: (err) => toast.error("Failed to forget", (err as Error).message),
  });

  return (
    <div className="p-6">
      <KHeader
        crumb={
          activeProjectName
            ? `global ∪ ${activeProjectName} · keyword + vector + graph`
            : "hybrid search · keyword + vector + graph"
        }
        title="Browse"
        right={
          <KBtn variant="primary" onClick={() => setComposing(true)}>
            Remember
          </KBtn>
        }
      />

      <KCard>
        {/* Search bar */}
        <div className="flex items-center gap-2.5 border-b border-rule-soft px-4 py-3">
          <span className="font-mono text-[13px] text-faint">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across all memories…"
            aria-label="Search memories"
            className="flex-1 border-none bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
          />
          <span className="rounded border border-rule px-1.5 py-0.5 font-mono text-[10px] text-faint">
            k=20
          </span>
        </div>

        {/* Summary strip + tier filter */}
        <div className="flex flex-wrap items-center gap-3 border-b border-rule-soft px-4 py-2.5 font-mono text-[11px] text-dim">
          <span>
            {loading
              ? "loading…"
              : `${results.length} hit${results.length === 1 ? "" : "s"}`}
            {isSearching && searchResp?.degraded ? (
              <span className="ml-2 text-warn">· graph degraded</span>
            ) : null}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {(
              [
                ["all", all.length],
                ["warm", tierCounts.warm],
                ["cold", tierCounts.cold],
              ] as const
            ).map(([key, count]) => (
              <button
                key={key}
                onClick={() => setTier(key)}
                aria-pressed={tier === key}
                className={cn(
                  "rounded-sm px-2 py-0.5 lowercase transition-colors",
                  tier === key
                    ? "bg-active text-ink"
                    : "text-faint hover:text-ink",
                  key === "warm" && tier === key && "text-warm",
                  key === "cold" && tier === key && "text-cold"
                )}
              >
                {key} {count}
              </button>
            ))}
          </div>
        </div>

        {/* Rows */}
        {loading && results.length === 0 ? (
          <KEmpty glyph="◌" title="Loading memories…" />
        ) : results.length === 0 ? (
          <KEmpty
            title={
              all.length > 0
                ? `No ${tier} entries`
                : isSearching
                ? "No memories matched"
                : "No memories yet"
            }
            hint={
              all.length > 0
                ? "The filter is hiding the rest — switch back to all."
                : isSearching
                ? "Try a broader query, or remember something new."
                : "Save your first memory and it will appear here."
            }
            action={
              !isSearching && all.length === 0 ? (
                <KBtn variant="primary" onClick={() => setComposing(true)}>
                  Remember something
                </KBtn>
              ) : null
            }
          />
        ) : (
          results.map((r) => (
            <ResultRow
              key={r.id}
              r={r}
              open={expanded === r.id}
              onToggle={() => setExpanded((c) => (c === r.id ? null : r.id))}
              onForget={() => setConfirmForget(r)}
            />
          ))
        )}
      </KCard>

      <Modal
        open={confirmForget !== null}
        onClose={() => setConfirmForget(null)}
        title="Forget this memory?"
        description="The entry, its vector and its graph edges are removed. This cannot be undone."
        footer={
          <div className="flex justify-end gap-2">
            <KBtn
              onClick={() => setConfirmForget(null)}
              disabled={forget.isPending}
            >
              Cancel
            </KBtn>
            <KBtn
              variant="danger"
              loading={forget.isPending}
              onClick={() => {
                if (confirmForget) forget.mutate(confirmForget);
              }}
            >
              Forget
            </KBtn>
          </div>
        }
      >
        <div className="text-[13px] leading-relaxed text-ink">
          {confirmForget?.content}
        </div>
        <div className="mt-2 font-mono text-[10px] text-dim">
          {confirmForget?.id}
        </div>
      </Modal>

      <Modal
        open={composing}
        onClose={() => setComposing(false)}
        title="Remember"
        description="Store a new memory. It lands in the warm tier and decays as it ages without hits."
        footer={
          <div className="flex justify-end gap-2">
            <KBtn
              onClick={() => setComposing(false)}
              disabled={remember.isPending}
            >
              Cancel
            </KBtn>
            <KBtn
              variant="primary"
              onClick={() => remember.mutate()}
              loading={remember.isPending}
              disabled={!newContent.trim()}
            >
              Save
            </KBtn>
          </div>
        }
      >
        <label
          htmlFor="remember-content"
          className="font-mono text-[10.5px] lowercase tracking-[0.05em] text-faint"
        >
          content
        </label>
        <textarea
          id="remember-content"
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          rows={6}
          autoFocus
          placeholder="One memory entry — sentence, decision, fact, fragment."
          className="mt-1.5 w-full resize-none rounded-lg border border-rule bg-input px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
      </Modal>
    </div>
  );
}

function ResultRow({
  r,
  open,
  onToggle,
  onForget,
}: {
  r: Row;
  open: boolean;
  onToggle: () => void;
  onForget: () => void;
}) {
  return (
    <div className="border-b border-rule-soft last:border-0">
      <div
        className={cn(
          "flex items-start gap-3 px-4 py-3 transition-colors",
          open ? "bg-active" : "hover:bg-subtle/50"
        )}
      >
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <KPill tone={r.tier === "warm" ? "warm" : "cold"}>{r.tier}</KPill>
            <span className="truncate text-[13px] leading-relaxed text-ink">
              {r.content}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 font-mono text-[10px] text-faint">
            <span>{r.id.slice(0, 8)}</span>
            <span>· ns {r.namespace}</span>
            <span>· {r.project ?? "global"}</span>
            <span>· {r.source}</span>
          </div>
        </button>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[15px] font-bold tabular-nums text-accent">
            {r.score.toFixed(2)}
          </div>
          <div className="font-mono text-[9px] text-faint">score</div>
        </div>
        <button
          onClick={onForget}
          aria-label={`Forget memory ${r.id.slice(0, 8)}`}
          title="Forget this memory"
          className="shrink-0 rounded p-1 font-mono text-[13px] leading-none text-faint transition-colors hover:text-err"
        >
          ⌫
        </button>
      </div>

      {open ? (
        <div className="border-t border-rule-soft bg-panel px-4 py-3">
          <div className="mb-3 text-[13px] leading-relaxed text-ink-2">
            {r.content}
          </div>
          {r.signals ? (
            <KSignals signals={r.signals} />
          ) : (
            // Recency ordering, not fusion: there is no ranking to show.
            <div className="font-mono text-[10.5px] text-faint">
              ordered by recency — search to see how the signals fused
            </div>
          )}
          <div className="mt-3 font-mono text-[10px] text-faint">{r.id}</div>
        </div>
      ) : null}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
