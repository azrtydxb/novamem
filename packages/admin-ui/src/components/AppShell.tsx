import { ReactNode, useEffect, useState } from "react";
import { Check, ChevronDown, ExternalLink, FolderKanban, LogOut, Moon, Sun } from "lucide-react";
import { cn } from "../lib/utils";
import { useAuth } from "../lib/auth-context";
import { useActiveProject } from "../lib/active-project";

export type Tab =
  | "metrics"
  | "health"
  | "users"
  | "tokens"
  | "projects"
  | "browse"
  | "graph"
  | "today"
  | "onboarding";

interface NavItem {
  id: Tab;
  label: string;
  /** Mono glyph for the Grid sidebar — kept in sync with the design
   *  handoff README so the sidebar reads identically against the spec. */
  glyph: string;
}

const ADMIN_NAV: NavItem[] = [
  { id: "metrics", label: "Metrics", glyph: "◐" },
  { id: "health", label: "Health", glyph: "◇" },
  { id: "users", label: "Users", glyph: "○" },
];

const USER_NAV: NavItem[] = [
  { id: "metrics", label: "Metrics", glyph: "◐" },
  { id: "browse", label: "Browse", glyph: "≡" },
  { id: "graph", label: "Graph", glyph: "✦" },
  { id: "today", label: "Today", glyph: "◷" },
  { id: "projects", label: "Projects", glyph: "▢" },
  { id: "tokens", label: "API Tokens", glyph: "⌘" },
];

interface Props {
  active: Tab;
  onChange: (t: Tab) => void;
  children: ReactNode;
}

/** Theme hook — reads `<html class>` (set in main.tsx pre-mount), and
 *  writes back to localStorage so the choice persists. */
function useTheme(): ["dark" | "light", () => void] {
  const [theme, setTheme] = useState<"dark" | "light">(
    () =>
      typeof document !== "undefined" && document.documentElement.classList.contains("light")
        ? "light"
        : "dark",
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
  const nav = isAdmin ? ADMIN_NAV : USER_NAV;
  const [theme, toggleTheme] = useTheme();

  return (
    <div className="flex h-full">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:bg-accent focus:text-white focus:px-3 focus:py-1.5 focus:rounded-md focus:shadow-lg"
      >
        Skip to main content
      </a>
      <aside className="w-56 flex-none border-r border-rule bg-panel flex flex-col">
        {/* Brand block — synapse logo + name + role caption. */}
        <div className="px-4 py-4 border-b border-rule-soft flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-accent flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 6 L12 12 M20 6 L12 12 M4 18 L12 12 M20 18 L12 12"
                stroke="white"
                strokeWidth="1.4"
                strokeLinecap="round"
                fill="none"
              />
              <circle cx="12" cy="12" r="2.6" fill="white" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-ink tracking-tight">NovaMem</div>
            <div className="font-mono text-[10px] text-dim">
              {isAdmin ? "admin" : user?.username ?? "user"}
            </div>
          </div>
        </div>

        {/* Active-project switcher (user only — admins don't have projects).
            Selecting a project widens the BrowsePage / TodayPage / GraphPage
            scope to user-global ∪ this project via includeProjects. */}
        {!isAdmin && <ActiveProjectSwitcher />}

        {/* Nav */}
        <nav className="flex-1 p-2.5 overflow-y-auto scroll-thin">
          <div className="px-2.5 pt-1.5 pb-1 font-mono text-[10px] uppercase tracking-[0.10em] text-faint">
            {isAdmin ? "Operations" : "Workspace"}
          </div>
          <div className="space-y-0.5">
            {nav.map((item) => {
              const isActive = item.id === active;
              return (
                <button
                  key={item.id}
                  onClick={() => onChange(item.id)}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-2.5 h-9 rounded-md text-[13px] transition-colors",
                    isActive
                      ? "bg-subtle text-ink font-medium"
                      : "text-dim hover:bg-subtle/60 hover:text-ink",
                  )}
                >
                  <span
                    className={cn(
                      "w-3.5 font-mono text-xs",
                      isActive ? "text-accent" : "text-faint",
                    )}
                  >
                    {item.glyph}
                  </span>
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>

        {/* API docs + theme toggle */}
        <div className="px-2.5 pb-2">
          <a
            href="/api-docs"
            target="_blank"
            rel="noreferrer"
            className="w-full flex items-center gap-2.5 px-2.5 h-9 rounded-md text-[13px] text-dim hover:bg-subtle/60 hover:text-ink transition-colors"
          >
            <span className="w-3.5 font-mono text-xs text-faint">⌖</span>
            <span className="flex-1">API docs</span>
            <ExternalLink className="h-3 w-3 text-faint" />
          </a>
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-2.5 px-2.5 h-9 rounded-md text-[13px] text-dim hover:bg-subtle/60 hover:text-ink transition-colors"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? (
              <Sun className="h-3.5 w-3.5 text-faint" />
            ) : (
              <Moon className="h-3.5 w-3.5 text-faint" />
            )}
            <span className="flex-1 text-left">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
          </button>
        </div>

        {/* User card + sign-out */}
        <div className="p-3 border-t border-rule-soft">
          {user ? (
            <div className="flex items-center gap-2 mb-1.5">
              <div className="h-7 w-7 rounded-full bg-accent-soft flex items-center justify-center text-xs font-semibold text-accent uppercase">
                {user.username.charAt(0)}
              </div>
              <div className="flex-1 min-w-0 leading-tight">
                <div className="text-xs font-medium text-ink truncate">{user.username}</div>
                <div className="font-mono text-[10px] text-dim truncate">
                  {isAdmin ? "admin" : "user"}
                </div>
              </div>
            </div>
          ) : null}
          <button
            onClick={() => { void logout(); }}
            className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-dim hover:bg-subtle/60 hover:text-ink transition-colors"
          >
            <LogOut className="h-3.5 w-3.5 text-faint" />
            Sign out
          </button>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto scroll-thin">
        {children}
      </main>
    </div>
  );
}

/** Compact dropdown that toggles the user's active project. Persists to
 *  localStorage via the ActiveProjectContext. Renders nothing when the
 *  user has no projects yet — the empty switcher would just be noise. */
function ActiveProjectSwitcher() {
  const { activeProjectId, activeProjectName, setActiveProjectId, projects } = useActiveProject();
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

  const label = activeProjectId ? activeProjectName ?? "Project" : "Global memory";

  return (
    <div className="relative px-2.5 pt-2.5" data-project-switcher>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 h-9 rounded-md text-[12px] bg-subtle/40 hover:bg-subtle text-ink transition-colors border border-rule-soft"
        aria-label="Switch active project"
      >
        <FolderKanban className="h-3.5 w-3.5 text-accent" />
        <span className="flex-1 text-left truncate">{label}</span>
        <ChevronDown className="h-3 w-3 text-faint" />
      </button>
      {open && (
        <div className="absolute z-30 left-2.5 right-2.5 mt-1 bg-panel border border-rule rounded-md shadow-lg overflow-hidden">
          <button
            onClick={() => { setActiveProjectId(null); setOpen(false); }}
            className="w-full flex items-center gap-2 px-2.5 h-9 text-[12px] text-ink hover:bg-subtle/60"
          >
            <span className="w-3.5 flex justify-center">
              {activeProjectId === null ? <Check className="h-3 w-3 text-accent" /> : null}
            </span>
            <span className="flex-1 text-left">Global memory only</span>
          </button>
          <div className="border-t border-rule-soft" />
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => { setActiveProjectId(p.id); setOpen(false); }}
              className="w-full flex items-center gap-2 px-2.5 h-9 text-[12px] text-ink hover:bg-subtle/60"
              title={p.id}
            >
              <span className="w-3.5 flex justify-center">
                {p.id === activeProjectId ? <Check className="h-3 w-3 text-accent" /> : null}
              </span>
              <span className="flex-1 text-left truncate">{p.name}</span>
              <span className="font-mono text-[9px] text-faint uppercase">{p.role}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
