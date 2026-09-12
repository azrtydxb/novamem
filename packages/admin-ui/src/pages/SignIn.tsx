import { FormEvent, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api, type SessionUser } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { AuthFrame } from "../components/AuthFrame";

interface BetterAuthSignInResp {
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

export function SignIn() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapNeeded, setBootstrapNeeded] = useState(false);

  // Bootstrap nudge — when no users exist yet, /api/auth/get-session
  // returns null, but we can't distinguish "no users" from "not signed
  // in" without a probe. Skip the hint for now; a fresh deploy that
  // hits "Sign in" without creds gets the generic invalid-credentials
  // message. Operators with the bootstrap env set will succeed on the
  // first sign-in attempt against that account.
  useEffect(() => {
    setBootstrapNeeded(false);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    const r = await api<BetterAuthSignInResp>(
      "POST",
      "/api/auth/sign-in/email",
      {
        email: email.trim(),
        password,
      }
    );
    setBusy(false);
    if (r.ok && r.body?.user) {
      const u = r.body.user;
      const sessionUser: SessionUser = {
        id: u.id,
        username: u.email.split("@")[0] ?? u.email,
        role: (u.role ?? "user") as SessionUser["role"],
      };
      login(sessionUser, u.mustChangePassword === true);
    } else if (r.status === 401 || r.status === 400) {
      setError("Invalid email or password.");
    } else {
      setError(r.error ?? `Server returned ${r.status}.`);
    }
  };

  return (
    <AuthFrame
      caption="console"
      title="Sign in"
      blurb="Use the email and password your admin set up for you."
    >
      {bootstrapNeeded ? (
        <div className="mt-5 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft/40 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-warn" />
          <div className="text-xs text-dim">
            <span className="font-medium text-ink">No admin yet.</span> Set{" "}
            <code className="text-accent">
              NOVAMEM_BOOTSTRAP_ADMIN_USERNAME
            </code>{" "}
            +{" "}
            <code className="text-accent">
              NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD
            </code>{" "}
            on the server and restart to seed one.
          </div>
        </div>
      ) : null}

      <form onSubmit={submit} className="mt-5 space-y-3.5">
        <Input
          type="email"
          name="email"
          label="Email"
          placeholder="alice@example.com"
          autoFocus
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
          disabled={!email.trim() || !password}
          className="w-full !h-10"
        >
          Continue
        </Button>
      </form>
    </AuthFrame>
  );
}
