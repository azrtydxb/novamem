import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
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

interface BetterAuthSessionResp {
  user?: { id: string; email: string; name: string; role?: string };
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
      setState({ user, loading: false, needsPasswordChange: false });
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
