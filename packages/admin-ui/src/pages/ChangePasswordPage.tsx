import { FormEvent, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { useToast } from "../components/Toast";
import { Button } from "../components/Button";
import { Input } from "../components/Input";

export function ChangePasswordPage({ onDone }: { onDone: () => void }) {
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

    const r = await api<{ ok: boolean }>("POST", "/v1/auth/change-password", {
      currentPassword,
      newPassword,
    });

    setBusy(false);
    if (r.ok && r.body?.ok) {
      markPasswordChanged();
      success("Password changed");
      onDone();
    } else {
      toastError("Failed to change password", r.error ?? "Unknown error");
      setError(r.error ?? "Failed to change password.");
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-[440px] max-w-full bg-panel border border-rule rounded-xl p-8 shadow-modal">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="h-9 w-9 rounded-[10px] bg-warn flex items-center justify-center">
            <KeyRound className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-base font-semibold text-ink">Change password</div>
            <div className="font-mono text-[10px] text-dim">First-time login</div>
          </div>
        </div>

        <p className="text-[13px] text-dim mt-1.5 mb-5">
          The bootstrap password is shared across all first-time installations.
          Please set a unique password before continuing.
        </p>

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
            className="w-full !py-2.5 !text-[13px] !font-semibold"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Change password
          </Button>
        </form>
      </div>
    </div>
  );
}
