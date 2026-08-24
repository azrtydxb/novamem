interface Props {
  data: number[];
  /** Stroke colour — pass a CSS variable like `var(--color-accent)`
   *  so it adapts to theme switches. */
  color: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
}

/** Tiny inline sparkline — used inside KPI cards to show recent trend
 *  next to the headline value. Renders as an SVG polyline; min/max
 *  scales to the data so a flat-line at zero still shows a baseline. */
export function Sparkline({
  data,
  color,
  width = 72,
  height = 22,
  strokeWidth = 1.5,
}: Props) {
  if (data.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data
    .map(
      (v, i) =>
        `${(i / (data.length - 1)) * width},${
          height - ((v - min) / range) * (height - 4) - 2
        }`
    )
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        points={pts}
      />
    </svg>
  );
}
