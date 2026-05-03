import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, SessionUser } from "./api";

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  /** Called after a successful login — caller passes the user from the
   *  login response; the server has already set the HttpOnly cookie. */
  login: (user: SessionUser) => void;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthCtx = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Resolves the current session by calling /v1/auth/me. The session lives
 *  in an HttpOnly cookie (the SPA never sees it directly); the only way
 *  to know if there's a session is to ask the server. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  const reload = useCallback(async () => {
    const r = await api<{ user: SessionUser }>("GET", "/v1/auth/me");
    if (r.ok && r.body?.user) {
      setState({ user: r.body.user, loading: false });
    } else {
      setState({ user: null, loading: false });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const login = useCallback((user: SessionUser) => {
    setState({ user, loading: false });
  }, []);

  const logout = useCallback(async () => {
    await api("POST", "/v1/auth/logout");
    setState({ user: null, loading: false });
  }, []);

  return (
    <AuthCtx.Provider value={{ ...state, login, logout, reload }}>{children}</AuthCtx.Provider>
  );
}
