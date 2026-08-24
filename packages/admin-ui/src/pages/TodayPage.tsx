import { useQuery } from "@tanstack/react-query";
import { api, ActivityEvent } from "../lib/api";
import { Card, CardContent } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { fmtRelative } from "../lib/utils";

interface TodayResp {
  events: ActivityEvent[];
}

const KIND_DOT: Record<ActivityEvent["kind"], string> = {
  remember: "bg-graph",
  token: "bg-accent",
  project: "bg-warm",
  audit: "bg-faint",
};

const KIND_LABEL: Record<ActivityEvent["kind"], string> = {
  remember: "remember",
  token: "token",
  project: "project",
  audit: "audit",
};

export function TodayPage() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, isFetching } = useQuery({
    queryKey: ["today"],
    queryFn: async () => {
      const r = await api<TodayResp>("GET", "/v1/me/today");
      if (!r.ok || !r.body) throw new Error(r.error ?? `today ${r.status}`);
      return r.body;
    },
    refetchInterval: 15_000,
  });

  const events = data?.events ?? [];

  return (
    <>
      <PageHeader
        kicker={`Activity · ${today}`}
        title="Today"
        subtitle="Your recent memories, tokens, and project changes."
      />
      <div className="p-5">
        <Card>
          {isFetching && events.length === 0 ? (
            <CardContent className="text-center text-dim text-sm py-12">
              Loading activity…
            </CardContent>
          ) : events.length === 0 ? (
            <CardContent className="text-center py-12">
              <div className="font-mono text-[11px] text-faint mb-1">
                no_activity
              </div>
              <div className="text-base font-medium text-ink mb-1">
                Nothing yet today
              </div>
              <div className="text-sm text-dim">
                Remembers, token mints, and project joins will show up here.
              </div>
            </CardContent>
          ) : (
            events.map((e, i) => (
              <div
                key={`${e.at}-${i}`}
                className="grid items-center gap-3.5 px-[18px] py-3.5 border-b border-rule-soft last:border-b-0"
                style={{ gridTemplateColumns: "auto 92px 1fr" }}
              >
                <div className={`h-2 w-2 rounded-full ${KIND_DOT[e.kind]}`} />
                <span className="font-mono text-[11px] text-dim">
                  {fmtRelative(e.at)}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-dim bg-subtle rounded px-1.5 py-0.5">
                      {KIND_LABEL[e.kind]}
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
        </Card>
      </div>
    </>
  );
}
