import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, SessionUser } from "./api";

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  needsPasswordChange: boolean;
}

interface AuthContextValue extends AuthState {
  /** Called after a successful login — caller passes the user from the
   *  login response and an optional flag indicating whether there's a
   *  pending password change request. */
  login: (user: SessionUser, pendingPasswordChange?: boolean) => void;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  /** Called after the user successfully changes their password, clearing
   *  the `needsPasswordChange` flag so the main dashboard appears. */
  markPasswordChanged: () => void;
}

const AuthCtx = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Whether a change of signed-in identity should wipe the query cache.
 *
 *  Only when *leaving* a known identity. The first resolve of a page load
 *  goes `null -> someone`, and clearing there is both pointless — a fresh
 *  page has nothing stale — and harmful: it lands at the exact moment
 *  queries gated on `enabled: !!userId` are starting, wipes them mid
 *  flight, and leaves their observers idle with no refetch.
 *
 *  That is not hypothetical. The first version cleared on every change and
 *  silently suppressed `/v1/me/projects`, so the sidebar's project
 *  switcher never rendered for anyone — the request was not slow or
 *  failing, it was never made.
 *
 *  Sign-out sets the user to null, so account switching still passes
 *  through `someone -> null` and clears there. A direct `a -> b` swap
 *  clears too.
 */
export function shouldClearCache(
  prev: string | null,
  next: string | null
): boolean {
  return prev !== null && prev !== next;
}

interface BetterAuthSessionResp {
  user?: {
    id: string;
    email: string;
    name: string;
    role?: string;
    /** Set by the server when the user still owes a password change —
     *  admin-created accounts and the env-seeded bootstrap admin. */
    mustChangePassword?: boolean;
  };
  session?: { id: string; expiresAt: string };
}

/** Resolves the current session via Better Auth's /api/auth/get-session.
 *  The session cookie is HttpOnly so the SPA never sees it directly —
 *  the only way to know if a user is signed in is to ask the server. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    needsPasswordChange: false,
  });

  // Every cached query in this SPA is scoped to the signed-in user by the
  // session cookie, but none of the keys say so — ["browse-recent",
  // project] is the same key for everyone. The QueryClient is a singleton
  // that outlives a sign-out, so signing in as someone else on the same
  // tab would render the previous account's memories, metrics and search
  // hits from cache until each request came back.
  //
  // Clearing on identity change fixes all of those at once, and keeps
  // fixing the next one: a key added later cannot forget to include a
  // user id it never had to include.
  const queryClient = useQueryClient();
  const lastUserId = useRef<string | null>(null);
  useEffect(() => {
    const id = state.user?.id ?? null;
    const prev = lastUserId.current;
    lastUserId.current = id;
    if (shouldClearCache(prev, id)) queryClient.clear();
  }, [state.user?.id, queryClient]);

  const reload = useCallback(async () => {
    const r = await api<BetterAuthSessionResp>("GET", "/api/auth/get-session");
    if (r.ok && r.body?.user) {
      const u = r.body.user;
      // Map Better Auth's user shape onto the SessionUser the rest of
      // the app expects. We treat the email's local-part as the
      // displayable username so the UI stays readable.
      const user: SessionUser = {
        id: u.id,
        username: u.email.split("@")[0] ?? u.email,
        role: (u.role ?? "user") as SessionUser["role"],
      };
      // The server's own answer, not a hardcoded false. Reading it on
      // every session resolve (not just at sign-in) means a reload while
      // the obligation stands lands back on the password screen rather
      // than slipping into the app.
      setState({
        user,
        loading: false,
        needsPasswordChange: u.mustChangePassword === true,
      });
    } else {
      setState({ user: null, loading: false, needsPasswordChange: false });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const login = useCallback(
    (user: SessionUser, pendingPasswordChange = false) => {
      setState({
        user,
        loading: false,
        needsPasswordChange: pendingPasswordChange,
      });
    },
    []
  );

  const logout = useCallback(async () => {
    await api("POST", "/api/auth/sign-out");
    setState({ user: null, loading: false, needsPasswordChange: false });
  }, []);

  const markPasswordChanged = useCallback(() => {
    setState((s) => ({ ...s, needsPasswordChange: false }));
  }, []);

  return (
    <AuthCtx.Provider
      value={{ ...state, login, logout, reload, markPasswordChanged }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
