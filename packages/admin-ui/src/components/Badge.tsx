import { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

const TONE: Record<Tone, string> = {
  neutral: "bg-subtle text-dim border-rule",
  success: "bg-graph-soft text-graph border-graph/30",
  warning: "bg-warn-soft text-warn border-warn/30",
  danger: "bg-err-soft text-err border-err/30",
  accent: "bg-accent-soft text-accent border-accent/30",
};

export function Badge({ className, tone = "neutral", ...rest }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}
