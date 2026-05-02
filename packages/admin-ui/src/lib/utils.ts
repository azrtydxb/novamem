/** Tiny `cn` — joins class names, drops falsy. Used everywhere instead
 *  of `clsx` to avoid a dependency for one line of code. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Format a number for display in stat cards: tabular, abbreviated for big
 *  values, sensible decimals for small ones. */
export function fmtNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "k";
  if (Math.abs(n) < 10 && !Number.isInteger(n)) return n.toFixed(2).replace(/\.?0+$/, "");
  return Math.round(n).toLocaleString();
}

/** Truncate a sha256 hex hash for display: first 8 + ellipsis + last 4. */
export function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  if (h.length <= 16) return h;
  return h.slice(0, 8) + "…" + h.slice(-4);
}

/** Render an ISO timestamp as a compact `YYYY-MM-DD HH:MM:SS` string. */
export function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
  } catch {
    return iso;
  }
}

/** Time-since helper. */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
