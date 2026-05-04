import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { api, SearchResult } from "../lib/api";
import { useActiveProject } from "../lib/active-project";
import { Card, CardContent } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";

interface RecentResp { results: SearchResult[] }
interface SearchResp { results: SearchResult[]; degraded: boolean }

/** Browse memories — combines `/v1/me/recent` (default view, last
 *  20 entries by created-time) with `/v1/me/search` (when the user
 *  types a query). The API returns the same SearchResult shape so the
 *  list rendering is identical. */
export function BrowsePage() {
  const [query, setQuery] = useState("");
  // Debounce input: render after 300ms of typing inactivity to avoid
  // thrashing the search backend on every keystroke.
  const debounced = useDebounced(query, 300);
  const isSearching = debounced.trim().length > 0;
  const queryClient = useQueryClient();
  const toast = useToast();
  const { activeProjectId, activeProjectName } = useActiveProject();
  // Active-project mode: union the user-global view with the selected
  // project so Browse shows both side-by-side. The query key includes
  // the id so React Query refetches whenever the user switches projects.
  const includeProjects = activeProjectId ? [activeProjectId] : undefined;

  const { data: recent, isFetching: recentLoading } = useQuery({
    queryKey: ["browse-recent", activeProjectId ?? "global"],
    queryFn: async () => {
      const r = await api<RecentResp>("POST", "/v1/me/recent", {
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
      const r = await api<SearchResp>("POST", "/v1/me/search", {
        query: debounced,
        k: 20,
        ...(includeProjects ? { includeProjects } : {}),
      });
      if (!r.ok || !r.body) throw new Error(r.error ?? `search ${r.status}`);
      return r.body;
    },
    enabled: isSearching,
  });

  const results = isSearching ? searchResp?.results ?? [] : recent?.results ?? [];
  const loading = isSearching ? searchLoading : recentLoading;
  const tierCounts = useMemo(() => {
    let warm = 0;
    let cold = 0;
    for (const r of results) {
      if (r.tier === "warm") warm++;
      else cold++;
    }
    return { warm, cold };
  }, [results]);

  const [composing, setComposing] = useState(false);
  const [newContent, setNewContent] = useState("");
  const remember = useMutation({
    mutationFn: async () => {
      // Writes follow the active scope: when a project is active, store
      // the new memory inside it; otherwise it's user-global.
      const r = await api<{ id: string }>("POST", "/v1/me/remember", {
        content: newContent.trim(),
        ...(activeProjectId ? { project: activeProjectId } : {}),
      });
      if (!r.ok) throw new Error(r.error ?? `remember ${r.status}`);
      return r.body;
    },
    onSuccess: () => {
      toast.success(
        "Memory stored",
        activeProjectName ? `Added to "${activeProjectName}".` : "Added to your memory.",
      );
      setComposing(false);
      setNewContent("");
      void queryClient.invalidateQueries({ queryKey: ["browse-recent"] });
    },
    onError: (err) => toast.error("Failed to remember", (err as Error).message),
  });

  return (
    <>
      <PageHeader
        kicker="Hybrid search · keyword + vector + graph"
        title="Browse memories"
        actions={
          <Button size="sm" onClick={() => setComposing(true)}>
            <Plus className="h-3.5 w-3.5" /> Remember
          </Button>
        }
      />
      <div className="p-5">
        <Card>
          {/* Search bar */}
          <div className="flex items-center gap-2.5 px-[18px] py-3.5 border-b border-rule-soft">
            <Search className="h-4 w-4 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search across all memories…"
              className="flex-1 bg-transparent border-none outline-none text-sm text-ink placeholder:text-faint"
            />
            <span className="font-mono text-[10px] text-faint border border-rule rounded px-1.5 py-0.5">
              k=20
            </span>
          </div>
          {/* Result summary strip */}
          <div className="flex items-center gap-3.5 px-[18px] py-2.5 border-b border-rule-soft font-mono text-[11px] text-dim">
            <span>
              {loading ? "loading…" : `${results.length} hit${results.length === 1 ? "" : "s"}`}
              {isSearching && searchResp?.degraded ? (
                <span className="ml-2 text-warn">· graph degraded</span>
              ) : null}
            </span>
            <span className="ml-auto flex items-center gap-3">
              <span className="text-warm">● warm {tierCounts.warm}</span>
              <span className="text-cold">● cold {tierCounts.cold}</span>
            </span>
          </div>

          {/* Result rows */}
          {loading && results.length === 0 ? (
            <div className="px-[18px] py-12 text-center text-dim text-sm">Loading memories…</div>
          ) : results.length === 0 ? (
            <EmptyState
              isSearching={isSearching}
              onCompose={() => setComposing(true)}
            />
          ) : (
            results.map((r, i, arr) => (
              <ResultRow key={r.id} r={r} last={i === arr.length - 1} />
            ))
          )}
        </Card>
      </div>

      <Modal
        open={composing}
        onClose={() => setComposing(false)}
        title="Remember"
        description="Store a new memory. It lands in the warm tier and decays as it ages without hits."
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setComposing(false)}
              disabled={remember.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => remember.mutate()}
              loading={remember.isPending}
              disabled={!newContent.trim()}
            >
              Save
            </Button>
          </div>
        }
      >
        <label className="text-xs font-medium text-ink">Content</label>
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          rows={6}
          autoFocus
          placeholder="One memory entry — sentence, decision, fact, fragment."
          className="mt-1.5 w-full rounded-lg border border-rule bg-bg px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-accent/40 resize-none"
        />
      </Modal>
    </>
  );
}

function ResultRow({ r, last }: { r: SearchResult; last: boolean }) {
  return (
    <div
      className={`grid items-center gap-3.5 px-[18px] py-3.5 ${
        last ? "" : "border-b border-rule-soft"
      }`}
      style={{ gridTemplateColumns: "auto 1fr 60px 60px" }}
    >
      <Pill tone={r.tier === "warm" ? "warm" : "cold"}>{r.tier}</Pill>
      <div>
        <div className="text-[13px] text-ink leading-relaxed">{r.content}</div>
        <div className="mt-1 font-mono text-[10px] text-dim">
          <span>{r.id.slice(0, 8)}</span>
          <span className="mx-1.5 text-faint">·</span>
          <span>project: {r.project ?? "—"}</span>
          <span className="mx-1.5 text-faint">·</span>
          <span>ns: {r.namespace}</span>
          <span className="mx-1.5 text-faint">·</span>
          <span>{r.source}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-base font-semibold tabular-nums text-accent">
          {r.score.toFixed(2)}
        </div>
        <div className="font-mono text-[9px] text-faint">score</div>
      </div>
      <div className="text-right">
        <div className="text-base font-semibold tabular-nums text-ink">
          {((r.signals?.keyword ?? 0) + (r.signals?.vector ?? 0) + (r.signals?.graph ?? 0)).toFixed(2)}
        </div>
        <div className="font-mono text-[9px] text-faint">signals</div>
      </div>
    </div>
  );
}

function EmptyState({
  isSearching,
  onCompose,
}: {
  isSearching: boolean;
  onCompose: () => void;
}) {
  return (
    <CardContent className="text-center py-14">
      <div className="font-mono text-[11px] text-faint mb-2">
        {isSearching ? "no_hits" : "no_memories"}
      </div>
      <div className="text-base font-medium text-ink mb-1">
        {isSearching ? "No memories matched" : "No memories yet"}
      </div>
      <div className="text-sm text-dim mb-4">
        {isSearching
          ? "Try a broader query, or remember something new."
          : "Save your first memory and it will appear here."}
      </div>
      {!isSearching ? (
        <Button onClick={onCompose}>
          <Plus className="h-3.5 w-3.5" /> Remember something
        </Button>
      ) : null}
    </CardContent>
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
