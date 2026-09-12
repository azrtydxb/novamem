import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ActivityEvent } from "../lib/api";
import { KCard } from "../components/k/KCard";
import { KHeader } from "../components/k/KHeader";
import { KEmpty } from "../components/k/KEmpty";
import { KPill } from "../components/k/KPill";
import { cn, fmtRelative } from "../lib/utils";

interface TodayResp {
  events: ActivityEvent[];
}

type Kind = ActivityEvent["kind"];

const KIND_DOT: Record<Kind, string> = {
  remember: "bg-graph",
  token: "bg-accent",
  project: "bg-warm",
  audit: "bg-faint",
};

const KINDS: Kind[] = ["remember", "token", "project", "audit"];

export function TodayPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [kind, setKind] = useState<Kind | "all">("all");

  const { data, isFetching } = useQuery({
    queryKey: ["today"],
    queryFn: async () => {
      const r = await api<TodayResp>("GET", "/v1/me/today");
      if (!r.ok || !r.body) throw new Error(r.error ?? `today ${r.status}`);
      return r.body;
    },
    refetchInterval: 15_000,
  });

  const all = data?.events ?? [];
  const events = kind === "all" ? all : all.filter((e) => e.kind === kind);
  // Only offer a filter for kinds that are actually in the feed: a chip
  // that can only ever select nothing is a dead control.
  const present = KINDS.filter((k) => all.some((e) => e.kind === k));

  return (
    <div className="p-6">
      <KHeader
        crumb={`activity · ${today}`}
        title="Today"
        right={<KPill tone="dim">{all.length}</KPill>}
      />

      <KCard
        title="feed"
        right={
          present.length > 1 ? (
            <span className="flex items-center gap-1">
              {(["all", ...present] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k as Kind | "all")}
                  aria-pressed={kind === k}
                  className={cn(
                    "rounded-sm px-1.5 py-0.5 lowercase transition-colors",
                    kind === k ? "bg-active text-ink" : "hover:text-ink"
                  )}
                >
                  {k}
                </button>
              ))}
            </span>
          ) : null
        }
      >
        {isFetching && all.length === 0 ? (
          <KEmpty glyph="◌" title="Loading activity…" />
        ) : events.length === 0 ? (
          <KEmpty
            glyph="◷"
            title={all.length > 0 ? `No ${kind} events` : "Nothing yet today"}
            hint={
              all.length > 0
                ? "The filter is hiding the rest — switch back to all."
                : "Remembers, token mints and project joins show up here as they happen."
            }
          />
        ) : (
          events.map((e, i) => (
            <div
              key={`${e.at}-${i}`}
              className="flex items-start gap-3 border-b border-rule-soft px-4 py-3 last:border-0 hover:bg-subtle/40"
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  KIND_DOT[e.kind]
                )}
              />
              <span
                className="w-20 shrink-0 font-mono text-[10.5px] text-faint"
                title={new Date(e.at).toLocaleString()}
              >
                {fmtRelative(e.at)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded-sm bg-subtle px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-dim">
                    {e.kind}
                  </span>
                  {e.project ? (
                    <span className="font-mono text-[10px] text-faint">
                      {e.project}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-[13px] text-ink">{e.text}</div>
              </div>
            </div>
          ))
        )}
      </KCard>
    </div>
  );
}
