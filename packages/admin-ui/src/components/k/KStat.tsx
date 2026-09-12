import { ReactNode } from "react";
import { KSpark } from "./KSpark";
import { cn } from "../../lib/utils";

interface Props {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Colour the value with a token. */
  tone?: "accent" | "cold" | "warm" | "graph" | "err";
  spark?: number[];
  sparkColor?: string;
  className?: string;
}

const TONE = {
  accent: "text-accent",
  cold: "text-cold",
  warm: "text-warm",
  graph: "text-graph",
  err: "text-err",
} as const;

/** KPI tile: lowercase label, big tabular value, optional sparkline. */
export function KStat({
  label,
  value,
  sub,
  tone,
  spark,
  sparkColor,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "rounded-lg border border-rule bg-panel px-4 py-3 shadow-card",
        className
      )}
    >
      <div className="font-mono text-[10.5px] tracking-[0.05em] lowercase text-faint">
        {label}
      </div>
      <div className="flex items-end justify-between gap-2.5">
        <div
          className={cn(
            "mt-1 font-mono text-[22px] font-bold tracking-[-0.02em] tabnum",
            tone ? TONE[tone] : "text-ink"
          )}
        >
          {value}
        </div>
        {spark && spark.length > 1 ? (
          <KSpark data={spark} color={sparkColor} />
        ) : null}
      </div>
      {sub ? (
        <div className="mt-1 font-mono text-[10px] text-faint-2">{sub}</div>
      ) : null}
    </div>
  );
}
