/** Resolved token values, for the things that cannot use a class.
 *
 *  Almost everything in this dashboard is styled with Tailwind classes
 *  bound to the tokens in index.css, so a theme switch repaints it for
 *  free. Two kinds of thing cannot work that way:
 *
 *    - recharts takes `stroke` and `fill` as PROPS, not classes
 *    - inline SVG (sparklines, the graph view, signal bars) does the same
 *
 *  Today those read from a hard-coded hex palette in MetricsPage, which
 *  is why toggling the theme repaints every panel on the page except the
 *  charts inside them. This resolves the same tokens the classes use, so
 *  there is one source of colour rather than two.
 */
import { useEffect, useState } from "react";

/** Tokens a chart or SVG is allowed to ask for. Deliberately a closed
 *  set: a typo in a CSS custom property name resolves to "" and paints
 *  nothing, which is a silent failure, so the compiler checks it here. */
export type ColorToken =
  | "accent"
  | "accent-soft"
  | "warm"
  | "warm-soft"
  | "cold"
  | "cold-soft"
  | "graph"
  | "graph-soft"
  | "err"
  | "warn"
  | "ink"
  | "dim"
  | "faint"
  | "faint-2"
  | "rule"
  | "panel"
  | "subtle-2"
  | "grid";

export type Palette = Record<ColorToken, string>;

const TOKENS: ColorToken[] = [
  "accent",
  "accent-soft",
  "warm",
  "warm-soft",
  "cold",
  "cold-soft",
  "graph",
  "graph-soft",
  "err",
  "warn",
  "ink",
  "dim",
  "faint",
  "faint-2",
  "rule",
  "panel",
  "subtle-2",
  "grid",
];

/** Read the live computed values off <html>. */
export function readPalette(): Palette {
  const out = {} as Palette;
  if (typeof document === "undefined") {
    // SSR/test safety: every consumer gets a defined string rather than
    // undefined, so a chart renders black instead of throwing.
    for (const t of TOKENS) out[t] = "";
    return out;
  }
  const s = getComputedStyle(document.documentElement);
  for (const t of TOKENS) out[t] = s.getPropertyValue(`--color-${t}`).trim();
  return out;
}

/** Palette hook that re-resolves when the theme changes.
 *
 *  The toggle swaps a `.light` class on <html>, so a MutationObserver on
 *  the class attribute is the signal — there is no event to listen for,
 *  and polling would repaint charts on a timer for no reason. */
export function usePalette(): Palette {
  const [palette, setPalette] = useState<Palette>(readPalette);

  useEffect(() => {
    // The pre-mount script in main.tsx may have set the class after this
    // module's first read, so resolve once on mount as well.
    setPalette(readPalette());

    const target = document.documentElement;
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(target, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return palette;
}

/** Stable colour ramp for per-series lines (per-token throughput), drawn
 *  from the palette rather than a hex list so it follows the theme.
 *  Cycles after 6 series. */
export function seriesColors(p: Palette): string[] {
  return [p.accent, p.cold, p.warm, p.graph, p.err, p.dim];
}
