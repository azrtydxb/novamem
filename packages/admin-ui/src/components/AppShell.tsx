import { ReactNode, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  FolderKanban,
  LogOut,
  Moon,
  Sun,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useAuth } from "../lib/auth-context";
import { useActiveProject } from "../lib/active-project";
import { useMetricsSnapshot } from "../lib/use-metrics";
import { KMark } from "./k/KMark";
import { KKbd } from "./k/KKbd";
import { CommandPalette } from "./CommandPalette";

export type Tab =
  | "overview"
  | "health"
  | "users"
  | "audit"
  | "home"
  | "tokens"
  | "projects"
  | "browse"
  | "graph"
  | "today"
  | "onboarding"
  | "password";

export interface NavItem {
  id: Tab;
  label: string;
  /** Mono glyph for the sidebar — the design uses a single glyph column
   *  rather than icons, so the nav reads as one monospaced block. */
  glyph: string;
  /** Which roles see this entry in the sidebar. Entries with no role
   *  listed are reachable only from the command palette. */
  roles: Array<"admin" | "user">;
  /** Extra words the ⌘K palette matches on, beyond the label. */
  keywords?: string;
}

/** The one nav registry.
 *
 *  Previously three arrays (`ADMIN_NAV`, `USER_NAV`, `ACCOUNT_NAV`) that
 *  the palette would have had to re-derive. One list with a `roles` field
 *  means the sidebar and ⌘K cannot disagree about what exists. */
export const NAV: NavItem[] = [
  // Home leads the list but not the admin sidebar: admins have no `home`
  // entry, so their filtered nav still starts with Overview. Users land
  // on Home, and a landing page listed second reads as the wrong one.
  {
    id: "home",
    label: "Home",
    glyph: "⌂",
    roles: ["user"],
    keywords: "search",
  },
  // Admin
  { id: "overview", label: "Overview", glyph: "◐", roles: ["admin", "user"] },
  { id: "health", label: "Health", glyph: "◇", roles: ["admin"] },
  { id: "users", label: "Users", glyph: "○", roles: ["admin"] },
  {
    id: "audit",
    label: "Audit log",
    glyph: "⎔",
    roles: ["admin"],
    keywords: "history actions who did what",
  },
  // User
  { id: "browse", label: "Browse", glyph: "≡", roles: ["user"] },
  { id: "graph", label: "Graph", glyph: "✦", roles: ["user"] },
  { id: "today", label: "Today", glyph: "◷", roles: ["user"] },
  { id: "projects", label: "Projects", glyph: "▢", roles: ["user"] },
  { id: "tokens", label: "API Tokens", glyph: "⌘", roles: ["user"] },
  // Palette-only. The v2 design puts these in the post-login flow rather
  // than the sidebar, but #292 fixed exactly the bug where they had no
  // route at all — so they keep one here, just not a nav row.
  {
    id: "onboarding",
    label: "Getting started",
    glyph: "◈",
    roles: [],
    keywords: "onboarding setup first steps",
  },
  {
    id: "password",
    label: "Change password",
    glyph: "⚿",
    roles: [],
    keywords: "account security credentials",
  },
];

export function navFor(role: "admin" | "user"): NavItem[] {
  return NAV.filter((i) => i.roles.includes(role));
}

interface Props {
  active: Tab;
  onChange: (t: Tab) => void;
  children: ReactNode;
}

/** Theme hook — reads `<html class>` (set in main.tsx pre-mount), and
 *  writes back to localStorage so the choice persists. */
function useTheme(): ["dark" | "light", () => void] {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("light")
      ? "light"
      : "dark"
  );
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("nm-theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

export function AppShell({ active, onChange, children }: Props) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === "admin";
  const nav = navFor(isAdmin ? "admin" : "user");
  const [theme, toggleTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ⌘K / Ctrl-K anywhere. Registered on the shell rather than inside the
  // palette so the shortcut works while the palette is closed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:bg-accent focus:text-accent-ink focus:px-3 focus:py-1.5 focus:rounded-md focus:shadow-lg"
      >
        Skip to main content
      </a>

      <aside className="w-[212px] flex-none border-r border-rule bg-panel flex flex-col">
        {/* Brand block */}
        <div className="px-3.5 py-3.5 border-b border-rule-soft flex items-center gap-2.5">
          <KMark size={28} />
          <div className="leading-tight min-w-0">
            <div className="font-mono text-[13px] font-bold text-ink tracking-tight">
              novamem
            </div>
            <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint truncate">
              {isAdmin ? "operator" : user?.username ?? "user"}
            </div>
          </div>
        </div>

        {/* Command palette trigger — the design's search affordance. It is
            a button, not a text field: typing happens in the overlay. */}
        <div className="px-2.5 pt-2.5">
          <button
            onClick={() => setPaletteOpen(true)}
            className="w-full flex items-center gap-2 px-2.5 h-8 rounded-md border border-rule-soft bg-subtle/40 hover:bg-subtle hover:border-rule transition-colors"
          >
            <span className="font-mono text-[11px] text-faint">⌕</span>
            <span className="flex-1 text-left font-mono text-[11px] text-dim">
              search
            </span>
            <KKbd>⌘K</KKbd>
          </button>
        </div>

        {/* Active-project switcher (user only — admins don't have projects).
            Selecting a project widens the BrowsePage / TodayPage / GraphPage
            scope to user-global ∪ this project via includeProjects. */}
        {!isAdmin && <ActiveProjectSwitcher />}

        <nav className="flex-1 p-2.5 overflow-y-auto scroll-thin">
          <div className="px-2.5 pt-1.5 pb-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint-2">
            {isAdmin ? "operations" : "workspace"}
          </div>
          <div className="space-y-0.5">
            {nav.map((item) => {
              const isActive = item.id === active;
              return (
                <button
                  key={item.id}
                  onClick={() => onChange(item.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "relative w-full flex items-center gap-2.5 px-2.5 h-8.5 rounded-md font-mono text-[12px] transition-colors",
                    isActive
                      ? "bg-active text-ink shadow-glow"
                      : "text-dim hover:bg-subtle hover:text-ink"
                  )}
                >
                  {isActive ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent"
                    />
                  ) : null}
                  <span
                    className={cn(
                      "w-3.5 text-center text-[12px] leading-none",
                      isActive ? "text-accent" : "text-faint"
                    )}
                  >
                    {item.glyph}
                  </span>
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <StoreCounts isAdmin={isAdmin} />

        {/* API docs + theme toggle */}
        <div className="px-2.5 pb-2">
          <a
            href="/api-docs"
            target="_blank"
            rel="noreferrer"
            className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md font-mono text-[11.5px] text-dim hover:bg-subtle hover:text-ink transition-colors"
          >
            <span className="w-3.5 text-center text-[12px] leading-none text-faint">
              ⌖
            </span>
            <span className="flex-1 text-left">API docs</span>
            <ExternalLink className="h-3 w-3 text-faint" />
          </a>
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md font-mono text-[11.5px] text-dim hover:bg-subtle hover:text-ink transition-colors"
            aria-label={
              theme === "dark"
                ? "Switch to light theme"
                : "Switch to dark theme"
            }
          >
            <span className="w-3.5 flex justify-center">
              {theme === "dark" ? (
                <Sun className="h-3.5 w-3.5 text-faint" />
              ) : (
                <Moon className="h-3.5 w-3.5 text-faint" />
              )}
            </span>
            <span className="flex-1 text-left">
              {theme === "dark" ? "Light theme" : "Dark theme"}
            </span>
          </button>
        </div>

        {/* Identity + sign-out */}
        <div className="p-2.5 border-t border-rule-soft">
          {user ? (
            <div className="flex items-center gap-2 mb-1 px-0.5">
              <div className="h-7 w-7 rounded-md bg-accent-soft flex items-center justify-center font-mono text-[11px] font-bold text-accent uppercase">
                {user.username.charAt(0)}
              </div>
              <div className="flex-1 min-w-0 leading-tight">
                <div className="text-[12px] font-medium text-ink truncate">
                  {user.username}
                </div>
                <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-faint truncate">
                  {isAdmin ? "admin" : "user"}
                </div>
              </div>
            </div>
          ) : null}
          <button
            onClick={() => {
              void logout();
            }}
            className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md font-mono text-[11.5px] text-dim hover:bg-subtle hover:text-ink transition-colors"
          >
            <span className="w-3.5 flex justify-center">
              <LogOut className="h-3.5 w-3.5 text-faint" />
            </span>
            <span className="flex-1 text-left">Sign out</span>
          </button>
        </div>
      </aside>

      <main
        id="main-content"
        tabIndex={-1}
        className="grid-bg flex-1 overflow-auto scroll-thin"
      >
        {children}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        role={isAdmin ? "admin" : "user"}
        onNavigate={(t) => {
          onChange(t);
          setPaletteOpen(false);
        }}
      />
    </div>
  );
}

/** Warm / cold / graph sizes, pinned above the footer.
 *
 *  Uses the same `useMetricsSnapshot` hook the Overview page does, so
 *  opening the dashboard costs one metrics request rather than two — and,
 *  more importantly, the two cannot disagree about the cached shape.
 *
 *  Gauges are nullable by contract: a tier that is disabled or
 *  unreachable reports `null`, and "—" says that, where a 0 would claim
 *  the store is empty. */
function StoreCounts({ isAdmin }: { isAdmin: boolean }) {
  const { data } = useMetricsSnapshot();
  const g = data?.data.gauges;
  const rows: Array<[string, number | null | undefined]> = [
    ["warm", g?.warm_entries],
    ["cold", g?.cold_entries],
    ["graph", g?.graph_edges],
  ];

  return (
    <div className="px-2.5 pb-2">
      <div className="rounded-md border border-rule-soft bg-subtle/30 px-2.5 py-2 space-y-1">
        <div className="pb-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-faint-2">
          {isAdmin ? "stores" : "your stores"}
        </div>
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between font-mono text-[10px]"
          >
            <span className="uppercase tracking-[0.1em] text-faint-2">
              {label}
            </span>
            <span className="text-dim tabular-nums">
              {value == null ? "—" : value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Compact dropdown that toggles the user's active project. Persists to
 *  localStorage via the ActiveProjectContext. Renders nothing when the
 *  user has no projects yet — the empty switcher would just be noise. */
function ActiveProjectSwitcher() {
  const { activeProjectId, activeProjectName, setActiveProjectId, projects } =
    useActiveProject();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.("[data-project-switcher]")) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (projects.length === 0) return null;

  const label = activeProjectId
    ? activeProjectName ?? "Project"
    : "Global memory";

  return (
    <div className="relative px-2.5 pt-2" data-project-switcher>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 h-8 rounded-md font-mono text-[11px] bg-subtle/40 hover:bg-subtle text-ink transition-colors border border-rule-soft"
        aria-label="Switch active project"
      >
        <FolderKanban className="h-3.5 w-3.5 text-accent" />
        <span className="flex-1 text-left truncate">{label}</span>
        <ChevronDown className="h-3 w-3 text-faint" />
      </button>
      {open && (
        <div className="absolute z-30 left-2.5 right-2.5 mt-1 bg-panel border border-rule rounded-md shadow-lg overflow-hidden">
          <button
            onClick={() => {
              setActiveProjectId(null);
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-2.5 h-9 text-[12px] text-ink hover:bg-subtle"
          >
            <span className="w-3.5 flex justify-center">
              {activeProjectId === null ? (
                <Check className="h-3 w-3 text-accent" />
              ) : null}
            </span>
            <span className="flex-1 text-left">Global memory only</span>
          </button>
          <div className="border-t border-rule-soft" />
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setActiveProjectId(p.id);
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-2.5 h-9 text-[12px] text-ink hover:bg-subtle"
              title={p.id}
            >
              <span className="w-3.5 flex justify-center">
                {p.id === activeProjectId ? (
                  <Check className="h-3 w-3 text-accent" />
                ) : null}
              </span>
              <span className="flex-1 text-left truncate">{p.name}</span>
              <span className="font-mono text-[9px] text-faint uppercase">
                {p.role}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
