import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listProjects = vi.fn();
let currentUser: { id: string; username: string; role: string } | null = null;

vi.mock("./api", () => ({
  api: (_method: string, path: string) => {
    if (path === "/v1/me/projects") return listProjects();
    throw new Error(`unexpected call to ${path}`);
  },
}));

vi.mock("./auth-context", () => ({
  useAuth: () => ({ user: currentUser }),
}));

const { ActiveProjectProvider, useActiveProject } = await import(
  "./active-project"
);

function Probe() {
  const { activeProjectId, activeProjectName } = useActiveProject();
  return (
    <div>
      <span data-testid="id">{activeProjectId ?? "none"}</span>
      <span data-testid="name">{activeProjectName ?? "none"}</span>
    </div>
  );
}

function renderProvider(children: ReactNode = <Probe />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ActiveProjectProvider>{children}</ActiveProjectProvider>
    </QueryClientProvider>
  );
}

describe("ActiveProjectProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    listProjects.mockReset();
    currentUser = { id: "user-a", username: "a", role: "user" };
  });

  it("does not hand one user the project another user activated", async () => {
    // The whole reason the key carries a user id. localStorage outlives a
    // sign-out, and the stale id was being sent as `project` on writes —
    // observed live as "no such project '01M2AJ…'" on a brand-new
    // account, naming a project owned by a since-deleted user.
    localStorage.setItem("nm-active-project:user-b", "proj-b");
    listProjects.mockResolvedValue({ ok: true, body: { projects: [] } });

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("id").textContent).toBe("none")
    );
    // user-b's choice is untouched — it is theirs, not shared.
    expect(localStorage.getItem("nm-active-project:user-b")).toBe("proj-b");
  });

  it("clears a stale id when the user turns out to have no projects", async () => {
    // The guard used to bail on `projects.length === 0`, treating an
    // empty list as "still loading". A user with no projects therefore
    // never cleared a stale id — the one case where it mattered most.
    localStorage.setItem("nm-active-project:user-a", "proj-gone");
    listProjects.mockResolvedValue({ ok: true, body: { projects: [] } });

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("id").textContent).toBe("none")
    );
    expect(localStorage.getItem("nm-active-project:user-a")).toBeNull();
  });

  it("clears a stale id when the project is gone from a non-empty list", async () => {
    localStorage.setItem("nm-active-project:user-a", "proj-gone");
    listProjects.mockResolvedValue({
      ok: true,
      body: { projects: [{ id: "proj-live", name: "Live", role: "owner" }] },
    });

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("id").textContent).toBe("none")
    );
  });

  it("keeps an id the user still belongs to, and resolves its name", async () => {
    localStorage.setItem("nm-active-project:user-a", "proj-live");
    listProjects.mockResolvedValue({
      ok: true,
      body: { projects: [{ id: "proj-live", name: "Live", role: "owner" }] },
    });

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("name").textContent).toBe("Live")
    );
    expect(screen.getByTestId("id").textContent).toBe("proj-live");
    expect(localStorage.getItem("nm-active-project:user-a")).toBe("proj-live");
  });

  it("does not clear a stale id while the list is still in flight", async () => {
    // The opposite failure: clearing on an empty-but-unloaded list would
    // silently drop a valid selection on every page load.
    localStorage.setItem("nm-active-project:user-a", "proj-live");
    let resolve: ((v: unknown) => void) | undefined;
    listProjects.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );

    renderProvider();

    expect(screen.getByTestId("id").textContent).toBe("proj-live");
    resolve?.({
      ok: true,
      body: { projects: [{ id: "proj-live", name: "Live", role: "owner" }] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("name").textContent).toBe("Live")
    );
  });
});
