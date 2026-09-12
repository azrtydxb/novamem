import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/utils";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

/** Mono uppercase action button — the same surface as `k/KBtn`, keeping
 *  the `size` and `ghost` variants that KBtn does not have and that the
 *  remaining callers pass. */
const VARIANT: Record<Variant, string> = {
  // text-accent-ink, not text-white: the accent is a mid-violet in dark
  // and a deeper one in light, and the readable foreground differs.
  primary:
    "bg-accent text-accent-ink border-transparent font-semibold hover:bg-accent-hover disabled:bg-accent/50",
  secondary: "bg-subtle text-ink-2 border-rule hover:bg-hover",
  danger: "bg-subtle text-err border-err-soft hover:bg-err-soft",
  ghost:
    "bg-transparent text-dim border-transparent hover:bg-subtle hover:text-ink",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[10.5px]",
  md: "h-9 px-3.5 text-xs",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    className,
    variant = "secondary",
    size = "md",
    loading,
    disabled,
    children,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-mono uppercase tracking-[0.04em] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
});
