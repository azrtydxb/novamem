import { ReactNode } from "react";

interface Props {
  /** Mono glyph — the design uses ∅ for "no results". */
  glyph?: string;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}

/** Empty state. Every list in the design has one; before this each page
 *  inlined its own, so they drifted apart in wording and spacing. */
export function KEmpty({ glyph = "∅", title, hint, action }: Props) {
  return (
    <div className="px-5 py-11 text-center">
      <div className="font-mono text-2xl text-faint-2">{glyph}</div>
      <div className="mt-2.5 font-mono text-sm text-ink-2">{title}</div>
      {hint ? (
        <div className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-faint">
          {hint}
        </div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
