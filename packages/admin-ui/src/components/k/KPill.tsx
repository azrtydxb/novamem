import { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type KTone =
  | "accent"
  | "cold"
  | "warm"
  | "graph"
  | "warn"
  | "err"
  | "dim";

const TONE: Record<KTone, string> = {
  accent: "bg-accent-soft text-accent",
  cold: "bg-cold-soft text-cold",
  warm: "bg-warm-soft text-warm",
  graph: "bg-graph-soft text-graph",
  warn: "bg-warn-soft text-warn",
  err: "bg-err-soft text-err",
  dim: "bg-subtle text-dim",
};

const DOT: Record<KTone, string> = {
  accent: "bg-accent",
  cold: "bg-cold",
  warm: "bg-warm",
  graph: "bg-graph",
  warn: "bg-warn",
  err: "bg-err",
  dim: "bg-faint",
};

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: KTone;
  dot?: boolean;
  pulse?: boolean;
}

/** Rounded lowercase mono chip. */
export function KPill({
  tone = "accent",
  dot,
  pulse,
  className,
  children,
  ...rest
}: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] leading-normal tracking-[0.05em] lowercase",
        TONE[tone],
        className
      )}
      {...rest}
    >
      {dot ? (
        <span
          className={cn(
            "mr-1.5 inline-block h-1.5 w-1.5 rounded-full",
            DOT[tone],
            pulse && "animate-pulse-soft"
          )}
        />
      ) : null}
      {children}
    </span>
  );
}
