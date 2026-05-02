import { ReactNode } from "react";
import { Activity, Database, Users, KeyRound, LogOut, Building2, ShieldCheck, FolderKanban } from "lucide-react";
import { cn } from "../lib/utils";
import { useAuth } from "../lib/auth-context";
import { Badge } from "./Badge";

export type Tab =
  | "metrics"
  | "health"
  | "tenants"
  | "users"
  | "tokens"
  | "projects";

interface NavItem {
  id: Tab;
  label: string;
  icon: typeof Activity;
}

const ADMIN_NAV: NavItem[] = [
  { id: "metrics", label: "Metrics", icon: Activity },
  { id: "health", label: "Health", icon: Database },
  { id: "tenants", label: "Tenants", icon: Building2 },
  { id: "users", label: "Users", icon: Users },
];

const USER_NAV: NavItem[] = [
  { id: "metrics", label: "Metrics", icon: Activity },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "tokens", label: "API tokens", icon: KeyRound },
];

interface Props {
  active: Tab;
  onChange: (t: Tab) => void;
  children: ReactNode;
}

export function AppShell({ active, onChange, children }: Props) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === "admin";
  const nav = isAdmin ? ADMIN_NAV : USER_NAV;

  return (
    <div className="flex h-full">
      <aside className="w-60 flex-none border-r border-border bg-bg-panel/40 flex flex-col">
        <div className="px-5 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-md bg-gradient-to-br from-accent to-accent/40 flex items-center justify-center">
              <span className="text-white font-bold text-sm">n</span>
            </div>
            <div>
              <div className="text-sm font-semibold text-text leading-tight">novamem</div>
              <div className="text-[11px] text-text-muted leading-tight">
                {isAdmin ? "admin console" : "tenant console"}
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-0.5">
          {nav.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === active;
            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-3 h-9 rounded-md text-sm transition-colors",
                  isActive
                    ? "bg-accent-subtle text-text font-medium"
                    : "text-text-muted hover:bg-bg-hover hover:text-text",
                )}
              >
                <Icon className={cn("h-4 w-4", isActive ? "text-accent" : "text-text-subtle")} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* User card + sign-out */}
        <div className="p-3 border-t border-border space-y-2">
          {user ? (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-bg-subtle/60">
              <div className="h-7 w-7 rounded-full bg-accent/20 flex-none flex items-center justify-center">
                <span className="text-[11px] font-semibold text-accent uppercase">
                  {user.username.charAt(0)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-text truncate">{user.username}</div>
                <div className="flex items-center gap-1 mt-0.5">
                  {isAdmin ? (
                    <Badge tone="accent" className="text-[10px] py-0 px-1">
                      <ShieldCheck className="h-2.5 w-2.5" /> admin
                    </Badge>
                  ) : (
                    <Badge tone="neutral" className="text-[10px] py-0 px-1">
                      {user.tenantId ?? "—"}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          ) : null}
          <button
            onClick={() => { void logout(); }}
            className="w-full flex items-center gap-2.5 px-3 h-9 rounded-md text-sm text-text-muted hover:bg-bg-hover hover:text-text transition-colors"
          >
            <LogOut className="h-4 w-4 text-text-subtle" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto scroll-thin">
        <div className="max-w-6xl mx-auto p-8">{children}</div>
      </main>
    </div>
  );
}
