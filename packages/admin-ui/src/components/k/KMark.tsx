import { cn } from "../../lib/utils";

/** Brand mark — a diamond in an accent-tinted rounded square. */
export function KMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[7px] border border-accent bg-accent-soft text-accent",
        className
      )}
    >
      ◆
    </span>
  );
}
