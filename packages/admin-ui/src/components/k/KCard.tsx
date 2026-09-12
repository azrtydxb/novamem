import { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface Props {
  /** Lowercase mono strip across the top. Omit for a bare panel. */
  title?: ReactNode;
  /** Right-aligned content in the title strip — a legend, a live pill. */
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Body padding. Off by default: most cards hold full-bleed rows or a
   *  chart that should touch the edges. */
  padded?: boolean;
}

/** Panel with an optional mono title strip.
 *
 *  The v2 design's basic container. Differs from the existing `Card` in
 *  that the header is part of the same component rather than a separate
 *  `CardHeader`, because every use in the design is the same shape:
 *  one lowercase label, optional right-hand adornment, a hairline, then
 *  content. */
export function KCard({ title, right, children, className, padded }: Props) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-rule bg-panel shadow-card",
        className
      )}
    >
      {title ? (
        <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5 font-mono text-[10.5px] tracking-[0.05em] lowercase text-dim">
          <span className="min-w-0 truncate">{title}</span>
          {right ? <span className="shrink-0">{right}</span> : null}
        </div>
      ) : null}
      <div className={cn(padded ? "p-4" : null)}>{children}</div>
    </div>
  );
}
