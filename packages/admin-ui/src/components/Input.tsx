import { InputHTMLAttributes, forwardRef, useId } from "react";
import { cn } from "../lib/utils";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, label, hint, error, id: idProp, ...rest },
  ref,
) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <div className="space-y-1.5">
      {label ? (
        <label htmlFor={id} className="block text-xs font-medium text-text-muted">
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={id}
        className={cn(
          "w-full h-9 rounded-md border bg-bg-panel px-3 text-sm font-mono",
          "placeholder:text-text-subtle",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          error ? "border-danger" : "border-border",
          "disabled:opacity-60 disabled:cursor-not-allowed",
          className,
        )}
        {...rest}
      />
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-text-subtle">{hint}</p>
      ) : null}
    </div>
  );
});
