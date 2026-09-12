import { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

/** Same tone vocabulary as before; the surface now matches `k/KPill`, so
 *  a badge and a pill on the same row no longer read as two components. */
const TONE: Record<Tone, string> = {
  neutral: "bg-subtle text-dim",
  success: "bg-graph-soft text-graph",
  warning: "bg-warn-soft text-warn",
  danger: "bg-err-soft text-err",
  accent: "bg-accent-soft text-accent",
};

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ className, tone = "neutral", ...rest }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] leading-normal tracking-[0.05em] lowercase",
        TONE[tone],
        className
      )}
      {...rest}
    />
  );
}
