import { ReactNode } from "react";
import { KMark } from "./k/KMark";
import { cn } from "../lib/utils";

interface Props {
  /** Mono caption under the wordmark — which screen this is. */
  caption: ReactNode;
  title: ReactNode;
  /** One line under the title explaining what to do. */
  blurb?: ReactNode;
  /** Card width. Sign-in is narrow; the password form has three fields. */
  width?: 380 | 440;
  children: ReactNode;
}

/** The shell for the screens rendered before the app shell exists.
 *
 *  Sign-in and the forced password change are outside `AppShell`, so they
 *  do not get its grid background or brand block for free — each had its
 *  own hand-rolled copy, and they had already drifted (different mark,
 *  different radius, different heading size). One frame, three uses. */
export function AuthFrame({
  caption,
  title,
  blurb,
  width = 380,
  children,
}: Props) {
  return (
    <div className="grid-bg flex min-h-full items-center justify-center p-6">
      <div
        className={cn(
          "max-w-full rounded-xl border border-rule bg-panel p-8 shadow-modal",
          width === 440 ? "w-[440px]" : "w-[380px]"
        )}
      >
        <div className="mb-6 flex items-center gap-2.5">
          <KMark size={34} />
          <div className="leading-tight">
            <div className="font-mono text-[15px] font-bold tracking-tight text-ink">
              novamem
            </div>
            <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">
              {caption}
            </div>
          </div>
        </div>

        <h2 className="m-0 font-mono text-[19px] font-bold tracking-[-0.015em] text-ink">
          {title}
        </h2>
        {blurb ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-dim">{blurb}</p>
        ) : null}

        {children}
      </div>
    </div>
  );
}
