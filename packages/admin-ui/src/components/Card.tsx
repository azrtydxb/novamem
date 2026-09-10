import { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-rule bg-panel shadow-card",
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
  // 14×18 padding per the Grid spec; soft rule under the header.
  return (
    <div
      className={cn("px-[18px] py-[14px] border-b border-rule-soft", className)}
      {...rest}
    />
  );
}

export function CardTitle({
  className,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-sm font-semibold text-ink", className)} {...rest} />
  );
}

export function CardDescription({
  className,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-dim mt-0.5", className)} {...rest} />;
}

export function CardContent({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-[18px]", className)} {...rest} />;
}
