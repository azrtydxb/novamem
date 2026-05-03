import { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

export type PillTone =
  | "accent"
  | "warm"
  | "cold"
  | "graph"
  | "warn"
  | "err"
  | "neutral";

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  /** Render the pill as a status dot + label combo (Grid `● live · 5 s`). */
  dot?: boolean;
  /** Pulse the dot — used on the live-data pill. */
  pulse?: boolean;
}

const TONE: Record<PillTone, string> = {
  accent: "bg-accent-soft text-accent",
  warm: "bg-warm-soft text-warm",
  cold: "bg-cold-soft text-cold",
  graph: "bg-graph-soft text-graph",
  warn: "bg-warn-soft text-warn",
  err: "bg-err-soft text-err",
  neutral: "bg-subtle text-dim",
};

const DOT_TONE: Record<PillTone, string> = {
  accent: "bg-accent",
  warm: "bg-warm",
  cold: "bg-cold",
  graph: "bg-graph",
  warn: "bg-warn",
  err: "bg-err",
  neutral: "bg-faint",
};

/** Mono uppercase status pill — see SECURITY.md `.pill` recipe in
 *  index.css. The `dot` variant adds a tiny coloured circle on the
 *  left for live/health indicators. */
export function Pill({ tone = "neutral", dot, pulse, className, children, ...rest }: Props) {
  return (
    <span className={cn("pill", TONE[tone], className)} {...rest}>
      {dot ? (
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full mr-1.5",
            DOT_TONE[tone],
            pulse ? "animate-pulse-soft" : null,
          )}
        />
      ) : null}
      {children}
    </span>
  );
}
