import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
}

const VARIANT = {
  primary:
    "bg-accent text-accent-ink border-transparent font-semibold hover:bg-accent-hover",
  secondary: "bg-subtle text-ink-2 border-rule hover:bg-hover",
  danger: "bg-subtle text-err border-err-soft hover:bg-err-soft",
} as const;

/** Mono uppercase action button.
 *
 *  `text-accent-ink` rather than a literal white: the design's accent is
 *  a mid-violet in dark and a deeper one in light, and the readable
 *  foreground differs between them. */
export const KBtn = forwardRef<HTMLButtonElement, Props>(function KBtn(
  { variant = "secondary", loading, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border font-mono text-xs uppercase tracking-[0.04em] transition-colors",
        variant === "primary" ? "px-4 py-2.5" : "px-3 py-2",
        VARIANT[variant],
        (disabled || loading) && "cursor-not-allowed opacity-60",
        className
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
});
