import { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

const TONE: Record<Tone, string> = {
  neutral: "bg-bg-subtle text-text-muted border-border",
  success: "bg-success-subtle text-success border-success/30",
  warning: "bg-warning-subtle text-warning border-warning/30",
  danger: "bg-danger-subtle text-danger border-danger/30",
  accent: "bg-accent-subtle text-accent border-accent/30",
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
