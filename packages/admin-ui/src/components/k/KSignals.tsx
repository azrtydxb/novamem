import { cn } from "../../lib/utils";

/** The fusion signals the server actually returns.
 *
 *  The v2 prototype draws five bars — keyword, vector, graph, recency,
 *  entity. This API returns three. The extra two are not hidden behind a
 *  zero bar, because a bar at zero reads as "this signal contributed
 *  nothing", not "this signal does not exist"; inventing them would put
 *  a confident-looking number on the screen that no code computes. */
export interface Signals {
  keyword: number;
  vector: number;
  graph: number;
}

const ORDER: Array<keyof Signals> = ["keyword", "vector", "graph"];

interface Props {
  signals: Signals;
  /** Abbreviate labels to three characters for cramped rows. */
  compact?: boolean;
  className?: string;
}

export function KSignals({ signals, compact, className }: Props) {
  return (
    <div className={cn("grid grid-cols-3 gap-3.5", className)}>
      {ORDER.map((key, i) => {
        const v = signals[key] ?? 0;
        return (
          <div key={key}>
            <div className="flex justify-between font-mono text-[10px] tracking-[0.05em] lowercase text-faint">
              <span>{compact ? key.slice(0, 3) : key}</span>
              <b className="font-medium text-ink-2">
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
