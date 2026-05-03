import { FormEvent, useEffect, useState } from "react";
import { LogIn, ShieldCheck, AlertTriangle } from "lucide-react";
import { api, type LoginResponse } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { Button } from "../components/Button";
import { Input } from "../components/Input";

export function SignIn() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapNeeded, setBootstrapNeeded] = useState(false);

  // Surface a hint when there are no admins yet — first-deploy operators
  // need the bootstrap-env nudge instead of a useless "invalid credentials".
  useEffect(() => {
    void api<{ ready: boolean; bootstrapNeeded: boolean }>("GET", "/v1/auth/status").then((r) => {
      if (r.body?.bootstrapNeeded) setBootstrapNeeded(true);
    });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    const r = await api<LoginResponse>("POST", "/v1/auth/login", {
      username: username.trim(),
      password,
    });
    setBusy(false);
    if (r.ok && r.body) {
      // Cookie has been set by the server; we just record the user.
      login(r.body.user);
    } else if (r.status === 401) {
      setError("Invalid username or password.");
    } else if (r.status === 404) {
      setError("Auth disabled on this server.");
    } else {
      setError(r.error ?? `Server returned ${r.status}.`);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-accent to-accent/40 flex items-center justify-center shadow-lg mb-4">
            <ShieldCheck className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-xl font-semibold text-text">novamem</h1>
          <p className="text-sm text-text-muted mt-1">Sign in to the dashboard.</p>
        </div>

        {bootstrapNeeded ? (
          <div className="mb-4 rounded-lg border border-warning/40 bg-warning-subtle/40 p-3 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-warning flex-none" />
            <div className="text-xs text-text-muted">
              <span className="text-text font-medium">No admin yet.</span> Set{" "}
              <code className="text-accent">NOVAMEM_BOOTSTRAP_ADMIN_USERNAME</code> +{" "}
              <code className="text-accent">NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD</code> on the server
              and restart to seed one.
            </div>
          </div>
        ) : null}

        <form
          onSubmit={submit}
          className="space-y-3 rounded-xl border border-border bg-bg-panel p-5 shadow-card"
        >
          <Input
            type="text"
            name="username"
            label="Username"
            placeholder="alice"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Input
            type="password"
            name="password"
            label="Password"
            placeholder="••••••••"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={error ?? undefined}
          />
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!username.trim() || !password}
            className="w-full"
          >
            <LogIn className="h-3.5 w-3.5" /> Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
