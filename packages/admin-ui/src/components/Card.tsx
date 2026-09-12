import { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

/** Panel primitive.
 *
 *  Kept alongside `k/KCard` rather than replaced by it: KCard folds the
 *  header into the component, which suits the pages whose header is
 *  always one lowercase label. The pages that still use this one have
 *  headers with a title *and* a paragraph of explanation, which KCard has
 *  no slot for. Both draw the same surface. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-rule bg-panel shadow-card",
        className
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("border-b border-rule px-4 py-2.5", className)}
      {...rest}
    />
  );
}

export function CardTitle({
  className,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "font-mono text-[10.5px] lowercase tracking-[0.05em] text-dim",
        className
      )}
      {...rest}
    />
  );
}

export function CardDescription({
  className,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("mt-1 text-xs leading-relaxed text-faint", className)}
      {...rest}
    />
  );
}

export function CardContent({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...rest} />;
}
