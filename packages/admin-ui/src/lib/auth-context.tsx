import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, setToken, SessionUser } from "./api";

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (token: string, user: SessionUser) => void;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthCtx = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Resolves the currently-stored session token to a user object. Calls
 *  /v1/auth/me on mount. Empty token → logged out. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  const reload = useCallback(async () => {
    if (!getToken()) {
      setState({ user: null, loading: false });
      return;
    }
    const r = await api<{ user: SessionUser }>("GET", "/v1/auth/me");
    if (r.ok && r.body?.user) {
      setState({ user: r.body.user, loading: false });
    } else {
      setToken("");
      setState({ user: null, loading: false });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const login = useCallback((token: string, user: SessionUser) => {
    setToken(token);
    setState({ user, loading: false });
  }, []);

  const logout = useCallback(async () => {
    await api("POST", "/v1/auth/logout");
    setToken("");
    setState({ user: null, loading: false });
  }, []);

  return (
    <AuthCtx.Provider value={{ ...state, login, logout, reload }}>{children}</AuthCtx.Provider>
  );
}
