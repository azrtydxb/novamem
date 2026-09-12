import { FormEvent, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { useToast } from "../components/Toast";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { AuthFrame } from "../components/AuthFrame";

/** `forced` is the first-login path, where the shell renders this page
 *  instead of the dashboard and the copy is about the shared bootstrap
 *  password. Reached voluntarily from the account menu it is an ordinary
 *  password change, and telling those users their password is a shared
 *  bootstrap credential is simply wrong. */
export function ChangePasswordPage({
  onDone,
  forced = false,
}: {
  onDone: () => void;
  forced?: boolean;
}) {
  const { markPasswordChanged } = useAuth();
  const { success, error: toastError } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword || !confirmPassword) return;
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must differ from current password.");
      return;
    }
    setBusy(true);
    setError(null);

    // Better Auth's change-password endpoint. Returns 200 on success and
    // 400 on a wrong current password.
    //
    // try/finally because api() THROWS ApiError on a non-2xx rather than
    // returning one: without it a wrong current password rejected before
    // setBusy(false) ever ran, leaving the form spinning with no error
    // shown and no way to retry. That path was unreachable while this
    // page was, so making it reachable is what exposed it.
    try {
      const r = await api<{ user: unknown }>(
        "POST",
        "/api/auth/change-password",
        {
          currentPassword,
          newPassword,
          revokeOtherSessions: true,
        }
      );
      if (r.ok) {
        markPasswordChanged();
        success("Password changed");
        onDone();
      } else {
        toastError("Failed to change password", r.error ?? "Unknown error");
        setError(r.error ?? "Failed to change password.");
      }
    } catch (err) {
      const message = (err as Error).message || "Failed to change password.";
      toastError("Failed to change password", message);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      width={440}
      caption={forced ? "first sign-in" : "account"}
      title="Change password"
      blurb={
        forced
          ? // Before 2b this copy said the password was "shared across all
            // first-time installations", which was only ever true of the
            // env-seeded bootstrap admin. The forced path now also fires
            // for admin-created accounts, whose password an admin typed
            // and therefore knows.
            "This account was created with a temporary password. Set one only you know before continuing."
          : "Set a new password for your account. Other sessions are signed out."
      }
    >
      <form onSubmit={submit} className="mt-5 space-y-3.5">
        <Input
          type="password"
          name="currentPassword"
          label="Current password"
          placeholder="••••••••"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <Input
          type="password"
          name="newPassword"
          label="New password"
          placeholder="••••••••"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <Input
          type="password"
          name="confirmPassword"
          label="Confirm new password"
          placeholder="••••••••"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          error={error ?? undefined}
        />
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!currentPassword || !newPassword || !confirmPassword}
          className="w-full !h-10"
        >
          Change password
        </Button>
      </form>
    </AuthFrame>
  );
}
