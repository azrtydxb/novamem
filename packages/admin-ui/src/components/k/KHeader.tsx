import { ReactNode } from "react";

interface Props {
  /** Lowercase mono line above the title — the design calls it a crumb. */
  crumb?: ReactNode;
  title: ReactNode;
  right?: ReactNode;
}

/** Page header: crumb, bold mono title, right-aligned actions. */
export function KHeader({ crumb, title, right }: Props) {
  return (
    <div className="mb-4 flex items-end gap-4">
      <div className="min-w-0">
        {crumb ? (
          <div className="mb-1 font-mono text-[11px] tracking-[0.06em] lowercase text-faint">
            {crumb}
          </div>
        ) : null}
        <h1 className="m-0 font-mono text-[22px] font-bold tracking-[-0.01em] text-ink">
          {title}
        </h1>
      </div>
      {right ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
      ) : null}
    </div>
  );
}
