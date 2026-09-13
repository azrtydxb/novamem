import { cn } from "../../lib/utils";

/** The fusion signals behind a hit's score.
 *
 *  Every key is optional because the server's answer varies by route,
 *  which was checked against the running deployment rather than assumed:
 *
 *    /v1/search    all five — and `recency` is routinely the second
 *                  largest contributor, around 0.98 on fresh entries
 *    /v1/neighbors `graph` alone
 *    /v1/recent    no signals at all; it orders, it does not rank
 *
 *  This component used to hard-code three bars and drop `recency` and
 *  `entity`, on the stated grounds that "this API returns three". It
 *  does not, and never did — that came from a TypeScript interface that
 *  was wrong about the server, so the dashboard hid a signal doing real
 *  work. Rendering what arrives is both simpler and true for all three
 *  shapes. */
export const SIGNAL_ORDER = [
  "keyword",
  "vector",
  "graph",
  "recency",
  "entity",
] as const;

export type SignalName = (typeof SIGNAL_ORDER)[number];

/** Partial on purpose — see above. */
export type Signals = Partial<Record<SignalName, number>>;

interface Props {
  signals: Signals | undefined;
  /** Abbreviate labels to three characters for cramped rows. */
  compact?: boolean;
  className?: string;
}

export function KSignals({ signals, compact, className }: Props) {
  // Canonical order, but only the signals this response carried. A bar at
  // zero says "contributed nothing"; a missing bar says "not computed
  // here", and those are different claims.
  const present = SIGNAL_ORDER.filter((k) => signals?.[k] !== undefined);
  if (present.length === 0) return null;
  const stacked = present.length > 3;

  return (
    <div
      className={cn("grid gap-3.5", className)}
      style={{
        gridTemplateColumns: `repeat(${Math.min(
          present.length,
          5
        )}, minmax(0, 1fr))`,
      }}
    >
      {present.map((key, i) => {
        const v = signals?.[key] ?? 0;
        return (
          <div key={key}>
            {/* Side by side at three signals; stacked at five. A 34px
                column cannot hold a label and a value on one line —
                measured, after the first attempt merely traded
                overlapping labels for labels truncated to 4px. */}
            <div
              className={cn(
                "font-mono text-[10px] tracking-[0.05em] lowercase text-faint",
                stacked ? "leading-tight" : "flex justify-between gap-1"
              )}
            >
              <div className="truncate">{compact ? key.slice(0, 3) : key}</div>
              <b
                className={cn(
                  "font-medium text-ink-2 tabular-nums",
                  stacked && "block"
                )}
              >
                {/* .84 rather than 0.84 — the design drops the leading
                    zero so the numbers align under narrow labels. */}
                {v.toFixed(2).replace(/^0/, "")}
              </b>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-sm bg-subtle-2">
              <div
                className={cn(
                  "h-full rounded-sm transition-[width] duration-300",
                  i % 2 ? "bg-cold" : "bg-accent"
                )}
                style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
