import { FormEvent, useEffect, useState } from "react";
import { LogIn, AlertTriangle } from "lucide-react";
import { api, type SessionUser } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { Button } from "../components/Button";
import { Input } from "../components/Input";

interface BetterAuthSignInResp {
  user?: { id: string; email: string; name: string; role?: string };
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
      login(sessionUser, false);
    } else if (r.status === 401 || r.status === 400) {
      setError("Invalid email or password.");
    } else {
      setError(r.error ?? `Server returned ${r.status}.`);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-[380px] max-w-full bg-panel border border-rule rounded-xl p-8 shadow-modal">
        {/* Brand row — synapse logo + name + version pill (Grid spec). */}
        <div className="flex items-center gap-2.5 mb-6">
          <div className="h-9 w-9 rounded-[10px] bg-accent flex items-center justify-center">
            {/* novamem mark — 4-node graph traces an 'N'. Reads as graph
                (the product) and as the letter (the brand). */}
            <svg
              width="22"
              height="22"
              viewBox="0 0 32 32"
              aria-hidden="true"
              fill="none"
            >
              <g stroke="white" strokeWidth="1.7" strokeLinecap="round">
                <line x1="7" y1="24" x2="7" y2="8" />
                <line x1="7" y1="8" x2="25" y2="24" />
                <line x1="25" y1="24" x2="25" y2="8" />
              </g>
              <g fill="white">
                <circle cx="7" cy="24" r="2.6" />
                <circle cx="7" cy="8" r="2.6" />
                <circle cx="25" cy="24" r="2.6" />
                <circle cx="25" cy="8" r="2.6" />
              </g>
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold text-ink">NovaMem</div>
            <div className="font-mono text-[10px] text-dim">v1.1.2</div>
          </div>
        </div>

        <h2 className="text-xl font-semibold text-ink tracking-[-0.015em]">
          Sign in to your console
        </h2>
        <p className="text-[13px] text-dim mt-1.5">
          Use the email + password your admin set up for you.
        </p>

        {bootstrapNeeded ? (
          <div className="mt-5 rounded-lg border border-warn/40 bg-warn-soft/40 p-3 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-warn flex-none" />
            <div className="text-xs text-dim">
              <span className="text-ink font-medium">No admin yet.</span> Set{" "}
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
            className="w-full !py-2.5 !text-[13px] !font-semibold"
          >
            <LogIn className="h-3.5 w-3.5" /> Continue
          </Button>
        </form>
      </div>
    </div>
  );
}
