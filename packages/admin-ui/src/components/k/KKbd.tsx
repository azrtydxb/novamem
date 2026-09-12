import { ReactNode } from "react";

/** Keycap. The design uses a heavier bottom border to suggest a key. */
export function KKbd({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-b-2 border-rule bg-subtle px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-dim">
      {children}
    </span>
  );
}
