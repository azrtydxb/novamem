import { ReactNode } from "react";
import { LucideIcon } from "lucide-react";
import { Card } from "./Card";
import { cn } from "../lib/utils";

interface Props {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "accent" | "success" | "danger" | "warning";
  trail?: ReactNode;
}

const TONE = {
  default: "text-text",
  accent: "text-accent",
  success: "text-success",
  danger: "text-danger",
  warning: "text-warning",
};

export function StatCard({ label, value, sublabel, icon: Icon, tone = "default", trail }: Props) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
          {label}
        </div>
        {Icon ? <Icon className="h-3.5 w-3.5 text-text-subtle" /> : null}
      </div>
      <div className={cn("mt-2 text-2xl font-semibold tabular-nums", TONE[tone])}>{value}</div>
      {sublabel ? (
        <div className="mt-1 text-xs text-text-subtle tabular-nums">{sublabel}</div>
      ) : null}
      {trail ? <div className="mt-3">{trail}</div> : null}
    </Card>
  );
}
