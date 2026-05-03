import { FormEvent, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users as UsersIcon,
} from "lucide-react";
import { api, DashUser, Tenant } from "../lib/api";
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
      const r = await api<{ users: DashUser[] }>("GET", "/v1/admin/users");
      if (!r.ok || !r.body) throw new Error(r.error ?? `users ${r.status}`);
      return r.body.users;
    },
  });
  const tenantsQ = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => {
      const r = await api<{ tenants: Tenant[] }>("GET", "/v1/admin/tenants");
      if (!r.ok || !r.body) return [] as Tenant[];
      return r.body.tenants;
    },
  });
  const users: DashUser[] | null = usersQ.data ?? null;
  const tenants: Tenant[] = tenantsQ.data ?? [];
  const busy = usersQ.isFetching || tenantsQ.isFetching;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
  };

  return (
    <>
      <PageHeader
        kicker="Dashboard auth · username + password"
        title="Users"
        subtitle="Manage dashboard logins. Admins see everything; users are scoped to one tenant."
        actions={
          <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />
      <div className="p-5 space-y-3">
      <CreateUserCard tenants={tenants} onCreated={refresh} />

      <div className="space-y-3">
        {users === null ? (
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
                    <th className="text-left font-medium px-4 py-2.5">Tenant</th>
                    <th className="text-left font-medium px-4 py-2.5">Last login</th>
                    <th className="text-right font-medium px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => (
                    <UserRow key={u.id} user={u} tenants={tenants} onChange={refresh} />
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

function CreateUserCard({ tenants, onCreated }: { tenants: Tenant[]; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [tenantId, setTenantId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body =
      role === "admin"
        ? { username: username.trim(), password, role }
        : { username: username.trim(), password, role, tenantId };
    const r = await api("POST", "/v1/admin/users", body);
    setBusy(false);
    if (r.ok) {
      toast.success(`User "${username}" created`);
      setUsername("");
      setPassword("");
      setRole("user");
      setTenantId("");
      onCreated();
    } else {
      const msg = r.error ?? `status ${r.status}`;
      setError(msg);
      toast.error("Could not create user", msg);
    }
  };

  const canSubmit =
    username.trim().length >= 2 &&
    password.length >= 8 &&
    (role === "admin" || tenantId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create user</CardTitle>
        <CardDescription>
          Passwords must be at least 8 characters. The user signs in with username + password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              name="username"
              label="Username"
              placeholder="bob"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              error={error ?? undefined}
            />
            <Input
              type="password"
              name="password"
              label="Password"
              placeholder="min 8 chars"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[auto_1fr_auto] gap-3 items-end">
            <RoleSelector role={role} onChange={setRole} />
            <TenantSelector
              tenants={tenants}
              value={tenantId}
              onChange={setTenantId}
              disabled={role === "admin"}
            />
            <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
              <UserPlus className="h-3.5 w-3.5" /> Create
            </Button>
          </div>
          {role === "admin" ? (
            <div className="text-xs text-faint flex items-center gap-1.5">
              <AlertCircle className="h-3 w-3" /> Admins are not bound to a tenant.
            </div>
          ) : null}
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

function TenantSelector({
  tenants,
  value,
  onChange,
  disabled,
}: {
  tenants: Tenant[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-dim">Tenant</label>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={
            "w-full h-9 appearance-none rounded-md border border-rule bg-panel pl-3 pr-8 text-sm " +
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg " +
            (disabled ? "opacity-60 cursor-not-allowed" : "")
          }
        >
          <option value="">— select tenant —</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} ({t.name})
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-faint pointer-events-none" />
      </div>
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────

function UserRow({
  user,
  tenants,
  onChange,
}: {
  user: DashUser;
  tenants: Tenant[];
  onChange: () => void;
}) {
  const { user: me } = useAuth();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRole, setConfirmRole] = useState<{ to: "admin" | "user"; tenantId: string } | null>(
    null,
  );
  const toast = useToast();

  const isMe = me?.id === user.id;

  const setRole = async (to: "admin" | "user", tenantId: string | null) => {
    setConfirmRole(null);
    const r = await api("POST", `/v1/admin/users/${user.id}/role`, { role: to, tenantId });
    if (r.ok) {
      toast.success(to === "admin" ? "Promoted to admin" : "Demoted to user");
      onChange();
    } else {
      toast.error("Role change failed", r.error ?? `status ${r.status}`);
    }
  };

  const deleteUser = async () => {
    setConfirmDelete(false);
    const r = await api("DELETE", `/v1/admin/users/${user.id}`);
    if (r.ok) {
      toast.success(`User "${user.username}" deleted`);
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
              {user.username.charAt(0)}
            </span>
          </div>
          <div>
            <div className="font-medium text-ink">
              {user.username}
              {isMe && <span className="ml-1.5 text-faint text-xs">(you)</span>}
            </div>
            <div className="text-xs text-faint">created {fmtRelative(user.createdAt)}</div>
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
      <td className="px-4 py-3 text-dim">
        {user.tenantId ? (
          <code className="font-mono text-xs">{user.tenantId}</code>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-dim text-xs">
        {user.lastLoginAt ? fmtRelative(user.lastLoginAt) : <span className="text-faint">never</span>}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex gap-1">
          {user.role === "user" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRole({ to: "admin", tenantId: user.tenantId ?? "" })}
            >
              Promote
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRole({ to: "user", tenantId: "" })}
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
          title={`Delete user "${user.username}"?`}
          description="The user will be signed out everywhere. Their personal logins are removed; tokens they minted remain on the tenant."
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
              ? `Promote "${user.username}" to admin?`
              : `Demote "${user.username}" to user?`
          }
          description={
            confirmRole?.to === "admin"
              ? "Admins can manage all tenants and users."
              : "User accounts are scoped to a single tenant. Pick one below."
          }
          size="md"
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmRole(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  confirmRole &&
                  setRole(
                    confirmRole.to,
                    confirmRole.to === "admin" ? null : confirmRole.tenantId || null,
                  )
                }
                disabled={confirmRole?.to === "user" && !confirmRole?.tenantId}
              >
                {confirmRole?.to === "admin" ? "Promote" : "Demote"}
              </Button>
            </>
          }
        >
          {confirmRole?.to === "user" ? (
            <TenantSelector
              tenants={tenants}
              value={confirmRole.tenantId}
              onChange={(id) => setConfirmRole({ to: "user", tenantId: id })}
            />
          ) : null}
        </Modal>
      </td>
    </tr>
  );
}
