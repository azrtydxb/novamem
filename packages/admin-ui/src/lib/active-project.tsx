import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, Project } from "./api";

interface ActiveProjectCtx {
  /** ULID of the project the user has activated, or null = user-global only. */
  activeProjectId: string | null;
  /** Display name of the active project (resolved from /v1/me/projects). */
  activeProjectName: string | null;
  setActiveProjectId: (id: string | null) => void;
  /** All projects the caller belongs to (owner or member). Drives the switcher. */
  projects: Project[];
}

const Ctx = createContext<ActiveProjectCtx | null>(null);

const STORAGE_KEY = "nm-active-project";

export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(() => {
    if (typeof localStorage === "undefined") return null;
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  });

  const { data: projects = [] } = useQuery({
    queryKey: ["me", "projects", "switcher"],
    queryFn: async () => {
      const r = await api<{ projects: Project[] }>("GET", "/v1/me/projects");
      return r.ok && r.body ? r.body.projects : [];
    },
  });

  // Drop the active id if it's no longer in the user's project list (left,
  // got removed, project deleted). Otherwise the switcher would show a
  // blank pill and every request would 403.
  useEffect(() => {
    if (!activeProjectId) return;
    if (projects.length === 0) return; // not loaded yet
    if (!projects.some((p) => p.id === activeProjectId)) {
      setActiveProjectIdState(null);
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [projects, activeProjectId]);

  const setActiveProjectId = useCallback((id: string | null) => {
    setActiveProjectIdState(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const activeProjectName =
    projects.find((p) => p.id === activeProjectId)?.name ?? null;

  return (
    <Ctx.Provider
      value={{ activeProjectId, activeProjectName, setActiveProjectId, projects }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useActiveProject(): ActiveProjectCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActiveProject must be used inside ActiveProjectProvider");
  return v;
}

/** Convenience: returns `{ includeProjects: [activeProjectId] }` for splatting
 *  into a request body, or `{}` when no project is active. Lets callers do
 *  `api("POST", url, { ...body, ...activeScope() })` without a conditional. */
export function useActiveScope(): { includeProjects?: string[] } {
  const { activeProjectId } = useActiveProject();
  return activeProjectId ? { includeProjects: [activeProjectId] } : {};
}
