import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api, Project } from "./api";
import { useAuth } from "./auth-context";

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

/** Per-user, deliberately.
 *
 *  This was one key for the whole browser. localStorage outlives a
 *  sign-out, so the next account on the same browser inherited the
 *  previous one's active project and sent it as `project` on every
 *  write. Observed on a freshly created account whose first remember
 *  failed with "no such project '01M2AJ…'" — an id belonging to a user
 *  who had been deleted. Had the id instead named a project the new
 *  account *could* reach, the write would have silently landed in it. */
function storageKey(userId: string | null | undefined): string | null {
  return userId ? `nm-active-project:${userId}` : null;
}

/** The pre-per-user key. Nothing reads it any more; dropping it keeps it
 *  from sitting in every existing browser's devtools looking live. */
const LEGACY_SHARED_KEY = "nm-active-project";

function readStored(userId: string | null | undefined): string | null {
  const key = storageKey(userId);
  if (!key || typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(key);
  return v && v.length > 0 ? v : null;
}

export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(
    () => readStored(userId)
  );

  // Re-read when the signed-in account changes: the previous user's
  // choice must not carry over, and this user's own choice should come
  // back when they return.
  useEffect(() => {
    setActiveProjectIdState(readStored(userId));
  }, [userId]);

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_SHARED_KEY);
    } catch {
      // Private mode or blocked storage — nothing to clean up there.
    }
  }, []);

  // Same query key as ProjectsPage (`["me", "projects"]`) so a single
  // `invalidateQueries` after create/share/leave/delete refreshes both
  // the page and this sidebar switcher in lock-step. The two query
  // ID's used to differ (sidebar had `["me","projects","switcher"]`),
  // which made the sidebar miss new projects until a hard refresh — and
  // worse, made it surface deleted ones until the cache aged out.
  const { data: projects = [], isSuccess } = useQuery({
    queryKey: ["me", "projects"],
    enabled: !!userId,
    queryFn: async () => {
      const r = await api<{ projects: Project[] }>("GET", "/v1/me/projects");
      return r.ok && r.body ? r.body.projects : [];
    },
  });

  // Drop the active id if it is not in this user's project list — they
  // left it, were removed, or it was deleted.
  //
  // The guard used to skip on `projects.length === 0`, treating an empty
  // list as "not loaded yet". Those are different states, and the one it
  // could not see is exactly the dangerous one: a user with no projects
  // at all never cleared a stale id, so an account that had never
  // created a project kept scoping its writes to someone else's. Waiting
  // on `isSuccess` distinguishes them.
  useEffect(() => {
    if (!activeProjectId || !isSuccess) return;
    if (!projects.some((p) => p.id === activeProjectId)) {
      setActiveProjectIdState(null);
      const key = storageKey(userId);
      if (key) localStorage.removeItem(key);
    }
  }, [projects, isSuccess, activeProjectId, userId]);

  const setActiveProjectId = useCallback(
    (id: string | null) => {
      setActiveProjectIdState(id);
      const key = storageKey(userId);
      if (!key) return;
      if (id) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
    },
    [userId]
  );

  const activeProjectName =
    projects.find((p) => p.id === activeProjectId)?.name ?? null;

  return (
    <Ctx.Provider
      value={{
        activeProjectId,
        activeProjectName,
        setActiveProjectId,
        projects,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useActiveProject(): ActiveProjectCtx {
  const v = useContext(Ctx);
  if (!v)
    throw new Error(
      "useActiveProject must be used inside ActiveProjectProvider"
    );
  return v;
}

/** Convenience: returns `{ includeProjects: [activeProjectId] }` for splatting
 *  into a request body, or `{}` when no project is active. Lets callers do
 *  `api("POST", url, { ...body, ...activeScope() })` without a conditional. */
export function useActiveScope(): { includeProjects?: string[] } {
  const { activeProjectId } = useActiveProject();
  return activeProjectId ? { includeProjects: [activeProjectId] } : {};
}
