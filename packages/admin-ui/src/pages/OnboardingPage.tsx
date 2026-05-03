import { useQuery } from "@tanstack/react-query";
import { api, OnboardingState } from "../lib/api";
import { Card } from "../components/Card";

interface Step {
  n: number;
  label: string;
  hint: string;
  done: boolean;
}

interface Props {
  onSkip?: () => void;
  onContinue?: () => void;
}

/** Welcome wizard. Reads server-derived state from /v1/me/onboarding
 *  (which steps are objectively done — bootstrap, tenant, first token,
 *  first remember). Renders the canonical 5-step list from the design
 *  guide. The "Continue" button on the active step navigates to the
 *  page that completes that step. */
export function OnboardingPage({ onSkip, onContinue }: Props) {
  const { data } = useQuery({
    queryKey: ["onboarding"],
    queryFn: async () => {
      const r = await api<OnboardingState>("GET", "/v1/me/onboarding");
      if (!r.ok || !r.body) throw new Error(r.error ?? `onboarding ${r.status}`);
      return r.body;
    },
  });

  const steps: Step[] = [
    { n: 1, label: "Bootstrap admin", hint: "Seeded from env", done: data?.bootstrapDone ?? true },
    {
      n: 2,
      label: "Account ready",
      hint: data?.userId ? `signed in as ${data.userId}` : "—",
      done: data?.tenantDone ?? false,
    },
    {
      n: 3,
      label: "Mint your first token",
      hint: "Scope it to a project, or tenant-wide",
      done: data?.mintedToken ?? false,
    },
    {
      n: 4,
      label: "Connect your agent",
      hint: "MCP stdio · SSE · raw HTTP",
      done: false,
    },
    {
      n: 5,
      label: "Remember something",
      hint: "Watch it land in Browse",
      done: data?.remembered ?? false,
    },
  ];

  const activeIdx = steps.findIndex((s) => !s.done);
  const totalDone = steps.filter((s) => s.done).length;

  return (
    <div className="px-8 pt-12 pb-20 overflow-auto">
      <div className="max-w-[880px] mx-auto">
        <span className="kicker bg-accent-soft text-accent rounded-full px-2.5 py-1 inline-block">
          Welcome
        </span>
        <h1 className="mt-3 text-[36px] font-semibold tracking-[-0.025em] text-ink">
          Let's give your agent memory
        </h1>
        <div className="mt-2 text-[15px] text-dim">
          5 steps · {totalDone} already done
        </div>

        <Card className="mt-7 overflow-hidden">
          {steps.map((s, i, arr) => {
            const active = i === activeIdx;
            return (
              <div
                key={s.n}
                className={`grid items-center gap-3.5 px-[22px] py-5 ${
                  i < arr.length - 1 ? "border-b border-rule-soft" : ""
                } ${active ? "bg-accent-soft/40" : ""}`}
                style={{ gridTemplateColumns: "auto 1fr auto" }}
              >
                <div
                  className={
                    `flex-none w-9 h-9 rounded-full flex items-center justify-center font-semibold ` +
                    (s.done
                      ? "bg-accent text-white"
                      : active
                      ? "bg-panel border-2 border-accent text-accent"
                      : "border-2 border-rule text-faint")
                  }
                >
                  {s.done ? "✓" : s.n}
                </div>
                <div>
                  <div className="text-[15px] font-semibold text-ink">{s.label}</div>
                  <div className="text-[12px] text-dim mt-0.5">{s.hint}</div>
                </div>
                {active ? (
                  <button
                    onClick={onContinue}
                    className="border border-accent bg-accent text-white text-xs font-medium px-3.5 py-1.5 rounded-md hover:bg-accent-hover transition-colors"
                  >
                    Continue →
                  </button>
                ) : s.done ? null : (
                  <span className="font-mono text-[11px] text-faint">queued</span>
                )}
              </div>
            );
          })}
        </Card>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            ["Warm tier", "postgres FTS · keyword search", "var(--color-warm)"],
            ["Cold tier", "qdrant · vector cosine", "var(--color-cold)"],
            ["Graph", "falkor · neighbours", "var(--color-graph)"],
          ].map(([t, d, color]) => (
            <Card key={t} className="p-4">
              <div className="h-2 w-2 rounded-full" style={{ background: color }} />
              <div className="mt-2.5 text-sm font-semibold text-ink">{t}</div>
              <div className="mt-1 font-mono text-[11px] text-dim">{d}</div>
            </Card>
          ))}
        </div>

        {onSkip ? (
          <div className="mt-6 text-center">
            <button
              onClick={onSkip}
              className="text-xs text-dim hover:text-ink transition-colors"
            >
              Skip for now →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
