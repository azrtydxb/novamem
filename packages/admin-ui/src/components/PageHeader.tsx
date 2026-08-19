import { ReactNode } from "react";
import { cn } from "../lib/utils";

interface Props {
  /** Mono uppercase eyebrow above the title (Grid direction). */
  kicker?: ReactNode;
  /** H1. Letter-spacing tightens per the spec (`-0.02em`). */
  title: ReactNode;
  /** 13px body text under the title — typically a one-liner explaining
   *  what the page shows. */
  subtitle?: ReactNode;
  /** Right-aligned actions (buttons, pills, refresh). */
  actions?: ReactNode;
  className?: string;
}

/** Page-header strip used at the top of every authenticated screen.
 *  Lives flush against the main pane (no wrapping `Card`) so it can
 *  ride above the grid of cards beneath. */
export function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "px-7 pt-5 pb-4 border-b border-rule flex items-start gap-4",
        className
      )}
    >
      <div className="flex-1 min-w-0">
        {kicker ? <div className="kicker">{kicker}</div> : null}
        <h1 className="mt-1 text-[22px] font-semibold text-ink tracking-[-0.02em] leading-tight">
          {title}
        </h1>
        {subtitle ? (
          <div className="mt-1 text-[13px] text-dim">{subtitle}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2 flex-none">{actions}</div>
      ) : null}
    </div>
  );
}
