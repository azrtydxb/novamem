import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, SearchResult } from "../lib/api";
import { cn } from "../lib/utils";
import { NAV, NavItem, Tab } from "./AppShell";
import { KKbd } from "./k/KKbd";

interface Props {
  open: boolean;
  onClose: () => void;
  role: "admin" | "user";
  onNavigate: (t: Tab) => void;
}

/** Rows the palette can act on. Two kinds, deliberately in one list so
 *  ↑/↓ and Enter do not need to know which section they are in. */
type Row =
  | { kind: "nav"; item: NavItem }
  | { kind: "memory"; result: SearchResult };

/** ⌘K palette: jump to a page, or search memory.
 *
 *  Navigation comes from the shared `NAV` registry — including the two
 *  entries that have no sidebar row (Getting started, Change password),
 *  which is what keeps them reachable now that the v2 sidebar drops them.
 *
 *  Memory search runs only for the `user` role: `/v1/search` is scoped to
 *  the caller's own entries, and an admin account has none, so showing an
 *  always-empty section to operators would be noise. */
export function CommandPalette({ open, onClose, role, onNavigate }: Props) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset on each open: a palette that reopens holding the last query is
  // surprising, and the stale result list would flash before refetching.
  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const debounced = useDebounced(q, 180);
  const searchable = role === "user" && debounced.trim().length >= 2;

  const { data: results = [], isFetching } = useQuery({
    queryKey: ["palette-search", debounced],
    enabled: open && searchable,
    queryFn: async () => {
      // `k`, not `limit` — /v1/search names its cap k, and a wrong
      // key is silently ignored, which would return the default 20.
      const r = await api<{ results: SearchResult[] }>("POST", "/v1/search", {
        query: debounced,
        k: 6,
      });
      return r.body?.results ?? [];
    },
    // A palette is a scratch surface; keeping its results around after it
    // closes only risks showing them against a later, different query.
    gcTime: 30_000,
  });

  const navRows = useMemo<Row[]>(() => {
    const needle = q.trim().toLowerCase();
    return NAV.filter((i) => i.roles.includes(role) || i.roles.length === 0)
      .filter(
        (i) =>
          !needle ||
          i.label.toLowerCase().includes(needle) ||
          (i.keywords ?? "").includes(needle)
      )
      .map((item) => ({ kind: "nav", item } as Row));
  }, [q, role]);

  const rows = useMemo<Row[]>(
    () => [
      ...navRows,
      ...results.map((result) => ({ kind: "memory", result } as Row)),
    ],
    [navRows, results]
  );

  // The cursor is an index into a list that shrinks as the query narrows;
  // without this it can point past the end and Enter does nothing.
  useEffect(() => {
    setCursor((c) => (c >= rows.length ? 0 : c));
  }, [rows.length]);

  if (!open) return null;

  const activate = (row: Row) => {
    if (row.kind === "nav") {
      onNavigate(row.item.id);
    } else {
      // Memory hits jump to Browse, which is the page that can actually
      // render an entry with its tier, decay and signals.
      onNavigate("browse");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (rows.length ? (c + 1) % rows.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (rows.length ? (c - 1 + rows.length) % rows.length : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor];
      if (row) activate(row);
      return;
    }
    if (e.key === "Tab") {
      // Focus stays on the input: it is the only focusable control in the
      // dialog, so a real focus trap would be a loop of one. Swallowing
      // Tab stops focus escaping to the shell behind the overlay.
      e.preventDefault();
    }
  };

  const firstMemoryIdx = navRows.length;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-[560px] overflow-hidden rounded-xl border border-rule bg-panel shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-rule px-3.5 py-3">
          <span className="font-mono text-[13px] text-faint">⌕</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              role === "user" ? "Go to a page, or search memory…" : "Go to…"
            }
            aria-label="Command or search query"
            className="flex-1 bg-transparent font-mono text-[13px] text-ink placeholder:text-faint focus:outline-none"
          />
          {isFetching ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-faint border-t-transparent" />
          ) : null}
          <KKbd>esc</KKbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto scroll-thin p-1.5">
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center font-mono text-[11.5px] text-faint">
              {searchable && !isFetching ? "no matches" : "nothing to show"}
            </div>
          ) : null}

          {rows.map((row, i) => {
            const selected = i === cursor;
            return (
              <div key={row.kind === "nav" ? row.item.id : row.result.id}>
                {i === firstMemoryIdx && row.kind === "memory" ? (
                  <div className="px-3 pt-2.5 pb-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint-2">
                    memory
                  </div>
                ) : null}
                {i === 0 && row.kind === "nav" ? (
                  <div className="px-3 pt-1.5 pb-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint-2">
                    go to
                  </div>
                ) : null}
                <button
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => activate(row)}
                  aria-selected={selected}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    selected ? "bg-active" : "hover:bg-subtle"
                  )}
                >
                  {row.kind === "nav" ? (
                    <>
                      <span
                        className={cn(
                          "w-3.5 text-center font-mono text-[12px] leading-none",
                          selected ? "text-accent" : "text-faint"
                        )}
                      >
                        {row.item.glyph}
                      </span>
                      <span className="flex-1 truncate font-mono text-[12.5px] text-ink">
                        {row.item.label}
                      </span>
                      {selected ? <KKbd>↵</KKbd> : null}
                    </>
                  ) : (
                    <>
                      <span
                        className={cn(
                          "w-3.5 text-center font-mono text-[12px] leading-none",
                          row.result.tier === "warm" ? "text-warm" : "text-cold"
                        )}
                      >
                        {row.result.tier === "warm" ? "◉" : "○"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-ink">
                          {row.result.content}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-faint">
                          {row.result.namespace}
                          {row.result.project ? ` · ${row.result.project}` : ""}
                          {` · ${row.result.score.toFixed(2)}`}
                        </span>
                      </span>
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-rule px-3.5 py-2 font-mono text-[10px] text-faint">
          <span className="flex items-center gap-1">
            <KKbd>↑</KKbd>
            <KKbd>↓</KKbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <KKbd>↵</KKbd> open
          </span>
        </div>
      </div>
    </div>
  );
}

/** Trailing-edge debounce, so typing a query does not fire a search per
 *  keystroke against the fusion pipeline. */
function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
