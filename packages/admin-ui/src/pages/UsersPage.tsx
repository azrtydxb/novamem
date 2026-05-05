import { FormEvent, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck, Trash2, UserPlus, Users as UsersIcon } from "lucide-react";
import { api } from "../lib/api";

/** Better Auth's "user" row shape (admin/list-users response). */
interface BAUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  createdAt: string;
  banned?: boolean | null;
}
import { useAuth } from "../lib/auth-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/Card";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { fmtRelative } from "../lib/utils";

export function UsersPage() {
  const queryClient = useQueryClient();
  const usersQ = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      // Better Auth's admin/list-users — paginated; default page size is
      // plenty for a small operator install.
      const r = await api<{ users: BAUser[]; total: number }>(
        "GET",
        "/api/auth/admin/list-users?limit=100",
      );
      if (!r.ok || !r.body) throw new Error(r.error ?? `users ${r.status}`);
      return r.body.users;
    },
    // Refetch when the user re-enters the tab and on window focus —
    // Better Auth occasionally returns 401 on the very first call after
    // session establishment, leaving the page blank without an obvious
    // reason. With these on, a tab-back recovers automatically.
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });
  const users: BAUser[] | null = usersQ.data ?? null;
  const busy = usersQ.isFetching;
  const fetchErr = usersQ.error as Error | null;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
  };

  return (
    <>
      <PageHeader
        kicker="Dashboard auth · username + password"
        title="Users"
        subtitle="Manage dashboard logins. Admins see everything; each user has their own memory namespace."
        actions={
          <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />
      <div className="p-5 space-y-3">
      <CreateUserCard onCreated={refresh} />

      <div className="space-y-3">
        {fetchErr ? (
          <Card className="p-8 text-center text-sm text-err">
            <div className="font-medium mb-1">Couldn't load users</div>
            <div className="text-dim text-xs">
              {fetchErr.message}
            </div>
            <Button size="sm" variant="ghost" onClick={refresh} className="mt-3">
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          </Card>
        ) : users === null ? (
          <Card className="p-8 text-center text-sm text-dim">Loading users…</Card>
        ) : users.length === 0 ? (
          <Card className="p-12 text-center">
            <UsersIcon className="h-8 w-8 text-faint mx-auto mb-3" />
            <div className="text-sm text-ink font-medium">No users yet</div>
            <div className="text-xs text-dim mt-1">Create your first user above.</div>
          </Card>
        ) : (
          <Card>
            <div className="overflow-hidden rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-subtle/60">
                  <tr className="text-dim text-[11px] uppercase tracking-wider">
                    <th className="text-left font-medium px-4 py-2.5">User</th>
                    <th className="text-left font-medium px-4 py-2.5">Role</th>
                    <th className="text-left font-medium px-4 py-2.5">Status</th>
                    <th className="text-right font-medium px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => (
                    <UserRow key={u.id} user={u} onChange={refresh} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
      </div>
    </>
  );
}

// ─── Create ────────────────────────────────────────────────────────────

function CreateUserCard({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Better Auth's admin/create-user. The request is gated by the
    // current admin session cookie (we're already signed in as admin
    // to even reach this page).
    const r = await api("POST", "/api/auth/admin/create-user", {
      email: email.trim(),
      name: name.trim() || email.split("@")[0] || "user",
      password,
      role,
    });
    setBusy(false);
    if (r.ok) {
      toast.success(`User "${email}" created`);
      setEmail("");
      setName("");
      setPassword("");
      setRole("user");
      onCreated();
    } else {
      const msg = r.error ?? `status ${r.status}`;
      setError(msg);
      toast.error("Could not create user", msg);
    }
  };

  const canSubmit = email.trim().includes("@") && password.length >= 8;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create user</CardTitle>
        <CardDescription>
          Each user signs in with email + password and owns their own memory namespace.
          Admins manage users only — they don't store memories or use the MCP.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              type="email"
              name="email"
              label="Email"
              placeholder="alice@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error ?? undefined}
            />
            <Input
              name="name"
              label="Display name (optional)"
              placeholder="Alice"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Input
            type="password"
            name="password"
            label="Password"
            placeholder="min 8 chars"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex items-end justify-between gap-3">
            <RoleSelector role={role} onChange={setRole} />
            <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
              <UserPlus className="h-3.5 w-3.5" /> Create
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function RoleSelector({
  role,
  onChange,
  disabled,
}: {
  role: "admin" | "user";
  onChange: (r: "admin" | "user") => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-dim">Role</label>
      <div className="inline-flex p-0.5 rounded-md border border-rule bg-bg">
        {(["user", "admin"] as const).map((r) => (
          <button
            key={r}
            type="button"
            disabled={disabled}
            onClick={() => onChange(r)}
            className={
              "h-8 px-3 text-xs font-medium rounded-sm transition-colors " +
              (role === r
                ? "bg-subtle text-ink shadow-sm"
                : "text-dim hover:text-ink") +
              (disabled ? " opacity-50 cursor-not-allowed" : "")
            }
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────

function UserRow({
  user,
  onChange,
}: {
  user: BAUser;
  onChange: () => void;
}) {
  const { user: me } = useAuth();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRole, setConfirmRole] = useState<{ to: "admin" | "user" } | null>(null);
  const toast = useToast();

  const isMe = me?.id === user.id;
  const displayName = user.name || user.email.split("@")[0] || user.email;

  const setRole = async (to: "admin" | "user") => {
    setConfirmRole(null);
    // Better Auth's admin/set-role.
    const r = await api("POST", "/api/auth/admin/set-role", {
      userId: user.id,
      role: to,
    });
    if (r.ok) {
      toast.success(to === "admin" ? "Promoted to admin" : "Demoted to user");
      onChange();
    } else {
      toast.error("Role change failed", r.error ?? `status ${r.status}`);
    }
  };

  const deleteUser = async () => {
    setConfirmDelete(false);
    // Better Auth's admin/remove-user. Better Auth POSTs the userId in
    // the body — there's no DELETE-by-id route.
    const r = await api("POST", "/api/auth/admin/remove-user", { userId: user.id });
    if (r.ok) {
      toast.success(`User "${user.email}" deleted`);
      onChange();
    } else {
      toast.error("Delete failed", r.error ?? `status ${r.status}`);
    }
  };

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-full bg-accent/15 flex-none flex items-center justify-center">
            <span className="text-[11px] font-semibold text-accent uppercase">
              {displayName.charAt(0)}
            </span>
          </div>
          <div>
            <div className="font-medium text-ink">
              {displayName}
              {isMe && <span className="ml-1.5 text-faint text-xs">(you)</span>}
            </div>
            <div className="text-xs text-faint">{user.email} · created {fmtRelative(user.createdAt)}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        {user.role === "admin" ? (
          <Badge tone="accent">
            <ShieldCheck className="h-3 w-3" /> admin
          </Badge>
        ) : (
          <Badge tone="neutral">user</Badge>
        )}
      </td>
      <td className="px-4 py-3 text-dim text-xs">
        {user.banned ? <Badge tone="danger">banned</Badge> : <span className="text-faint">active</span>}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex gap-1">
          {user.role === "user" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRole({ to: "admin" })}
            >
              Promote
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRole({ to: "user" })}
              disabled={isMe}
            >
              Demote
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmDelete(true)}
            disabled={isMe}
            title={isMe ? "you can't delete yourself" : "delete user"}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <Modal
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title={`Delete user "${user.email}"?`}
          description="The user will be signed out everywhere. Their personal logins, memory entries, and minted tokens are all removed."
          size="md"
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={deleteUser}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </>
          }
        />

        <Modal
          open={!!confirmRole}
          onClose={() => setConfirmRole(null)}
          title={
            confirmRole?.to === "admin"
              ? `Promote "${user.email}" to admin?`
              : `Demote "${user.email}" to user?`
          }
          description={
            confirmRole?.to === "admin"
              ? "Admins can manage all users."
              : "Demoting an admin makes them a regular user with their own memory namespace."
          }
          size="md"
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmRole(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => confirmRole && setRole(confirmRole.to)}
              >
                {confirmRole?.to === "admin" ? "Promote" : "Demote"}
              </Button>
            </>
          }
        />
      </td>
    </tr>
  );
}
