import { ReactNode } from "react";
import { LucideIcon } from "lucide-react";
import { Card } from "./Card";
import { Sparkline } from "./Sparkline";
import { cn } from "../lib/utils";

export type StatTone =
  | "default"
  | "accent"
  | "warm"
  | "cold"
  | "graph"
  | "err"
  | "warn";

interface Props {
  label: string;
  value: ReactNode;
  /** Small caption under the value — typically a context phrase like
   *  "rolling 60s" or "5 zero-hit". */
  sublabel?: ReactNode;
  icon?: LucideIcon;
  /** Recolours the value text — used to tint warm/cold/graph gauges. */
  tone?: StatTone;
  /** Optional ↑/↓ pct pill (Grid spec). Positive → graph tone,
   *  negative → warm. */
  delta?: number;
  /** Trend data for the inline sparkline. The sparkline picks up the
   *  StatCard's tone colour. */
  trend?: number[];
  /** Custom trailing element under the value/spark — overrides sublabel
   *  when set. */
  trail?: ReactNode;
}

const TONE_TEXT: Record<StatTone, string> = {
  default: "text-ink",
  accent: "text-accent",
  warm: "text-warm",
  cold: "text-cold",
  graph: "text-graph",
  err: "text-err",
  warn: "text-warn",
};

const TONE_VAR: Record<StatTone, string> = {
  default: "var(--color-ink)",
  accent: "var(--color-accent)",
  warm: "var(--color-warm)",
  cold: "var(--color-cold)",
  graph: "var(--color-graph)",
  err: "var(--color-err)",
  warn: "var(--color-warn)",
};

export function StatCard({
  label,
  value,
  sublabel,
  icon: Icon,
  tone = "default",
  delta,
  trend,
  trail,
}: Props) {
  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-dim flex items-center gap-1.5">
          {Icon ? <Icon className="h-3.5 w-3.5 text-faint" /> : null}
          {label}
        </div>
        {delta != null ? (
          <span
            className={cn(
              "font-mono text-[10px] px-1.5 py-0.5 rounded",
              delta >= 0 ? "bg-graph-soft text-graph" : "bg-warm-soft text-warm"
            )}
          >
            {delta >= 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(1)}%
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <div
          className={cn(
            "text-[26px] leading-none font-semibold tabular-nums tracking-[-0.02em]",
            TONE_TEXT[tone]
          )}
        >
          {value}
        </div>
        {trend && trend.length >= 2 ? (
          <Sparkline data={trend} color={TONE_VAR[tone]} />
        ) : null}
      </div>
      {trail ? (
        <div className="mt-2">{trail}</div>
      ) : sublabel ? (
        <div className="mt-1.5 text-[11px] text-faint tabular-nums">
          {sublabel}
        </div>
      ) : null}
    </Card>
  );
}
