import { usePalette } from "../../lib/theme-colors";

interface Props {
  data: number[];
  /** Resolved colour. Omit to use the accent token. */
  color?: string;
  width?: number;
  height?: number;
  /** Tint the area under the line. */
  fill?: boolean;
}

/** Sparkline.
 *
 *  Takes a resolved colour string rather than a class because SVG
 *  `stroke` is an attribute — see lib/theme-colors.ts for why that
 *  matters and how the value is kept in step with the theme. */
export function KSpark({ data, color, width = 76, height = 22, fill }: Props) {
  const palette = usePalette();
  const stroke = color ?? palette.accent;
  if (!data || data.length < 2) {
    return <svg width={width} height={height} className="block" />;
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map(
    (v, i) =>
      [
        (i / (data.length - 1)) * width,
        height - ((v - min) / range) * (height - 4) - 2,
      ] as const
  );
  const line = pts
    .map((p, i) => (i ? "L" : "M") + p.map((n) => n.toFixed(1)).join(" "))
    .join(" ");
  return (
    <svg width={width} height={height} className="block" aria-hidden>
      {fill ? (
        <path
          d={`${line} L${width} ${height} L0 ${height} Z`}
          fill={stroke}
          opacity="0.14"
        />
      ) : null}
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}
