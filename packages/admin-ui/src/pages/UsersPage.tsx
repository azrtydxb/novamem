import { FormEvent, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { KCard } from "../components/k/KCard";
import { KHeader } from "../components/k/KHeader";
import { KBtn } from "../components/k/KBtn";
import { KPill } from "../components/k/KPill";
import { KEmpty } from "../components/k/KEmpty";
import { Input } from "../components/Input";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { cn, fmtRelative } from "../lib/utils";

/** Better Auth's "user" row shape (admin/list-users response). */
interface BAUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  createdAt: string;
  banned?: boolean | null;
}

export function UsersPage() {
  const queryClient = useQueryClient();
  const usersQ = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      // Better Auth's admin/list-users — paginated; default page size is
      // plenty for a small operator install.
      const r = await api<{ users: BAUser[]; total: number }>(
        "GET",
        "/api/auth/admin/list-users?limit=100"
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
    <div className="p-6">
      <KHeader
        crumb="dashboard auth · username + password"
        title="Users"
        right={
          <>
            {users ? <KPill tone="dim">{users.length}</KPill> : null}
            <KBtn onClick={refresh} loading={busy}>
              Refresh
            </KBtn>
          </>
        }
      />

      <CreateUserCard onCreated={refresh} />

      <KCard className="mt-4" title="accounts">
        {fetchErr ? (
          <KEmpty
            glyph="⚠"
            title="Couldn't load users"
            hint={fetchErr.message}
            action={<KBtn onClick={refresh}>Try again</KBtn>}
          />
        ) : users === null ? (
          <KEmpty glyph="◌" title="Loading users…" />
        ) : users.length === 0 ? (
          <KEmpty
            title="No users yet"
            hint="Create the first one above. Each user owns their own memory namespace; admins manage accounts and don't store memories."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  {["user", "role", "status", ""].map((h, i) => (
                    <th
                      key={h || `sp${i}`}
                      className="px-4 py-2 font-mono text-[9.5px] font-normal uppercase tracking-[0.14em] text-faint-2"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.id} user={u} onChange={refresh} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </KCard>
    </div>
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
    <KCard title="create user">
      <form onSubmit={submit} className="space-y-3 p-4">
        <p className="max-w-2xl text-xs leading-relaxed text-dim">
          The password you set here is temporary: the account is created needing
          a change, so the user is sent straight to the change-password screen
          the first time they sign in.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
          label="Temporary password"
          placeholder="min 8 chars"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex items-end justify-between gap-3">
          <RoleSelector role={role} onChange={setRole} />
          <KBtn
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!canSubmit}
          >
            Create
          </KBtn>
        </div>
      </form>
    </KCard>
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
      <label className="block font-mono text-[10.5px] lowercase tracking-[0.05em] text-faint">
        role
      </label>
      <div className="inline-flex rounded-md border border-rule bg-bg p-0.5">
        {(["user", "admin"] as const).map((r) => (
          <button
            key={r}
            type="button"
            disabled={disabled}
            onClick={() => onChange(r)}
            className={cn(
              "h-8 rounded-sm px-3 font-mono text-[11px] lowercase transition-colors",
              role === r ? "bg-subtle text-ink" : "text-dim hover:text-ink",
              disabled && "cursor-not-allowed opacity-50"
            )}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────

function UserRow({ user, onChange }: { user: BAUser; onChange: () => void }) {
  const { user: me } = useAuth();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRole, setConfirmRole] = useState<{
    to: "admin" | "user";
  } | null>(null);
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
    const r = await api("POST", "/api/auth/admin/remove-user", {
      userId: user.id,
    });
    if (r.ok) {
      toast.success(`User "${user.email}" deleted`);
      onChange();
    } else {
      toast.error("Delete failed", r.error ?? `status ${r.status}`);
    }
  };

  return (
    <tr className="border-b border-rule-soft last:border-0 hover:bg-subtle/40">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-accent-soft">
            <span className="font-mono text-[11px] font-bold uppercase text-accent">
              {displayName.charAt(0)}
            </span>
          </div>
          <div className="min-w-0">
            <div className="text-[13px] text-ink">
              {displayName}
              {isMe ? (
                <span className="ml-1.5 font-mono text-[10px] text-faint">
                  (you)
                </span>
              ) : null}
            </div>
            <div className="font-mono text-[10px] text-faint">
              {user.email} · created {fmtRelative(user.createdAt)}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-2.5">
        <KPill tone={user.role === "admin" ? "accent" : "dim"}>
          {user.role === "admin" ? "admin" : "user"}
        </KPill>
      </td>
      <td className="px-4 py-2.5">
        {user.banned ? (
          <KPill tone="err">banned</KPill>
        ) : (
          <span className="font-mono text-[10.5px] text-faint">active</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right">
        <div className="inline-flex gap-1.5">
          {user.role === "user" ? (
            <KBtn onClick={() => setConfirmRole({ to: "admin" })}>Promote</KBtn>
          ) : (
            <KBtn
              onClick={() => setConfirmRole({ to: "user" })}
              disabled={isMe}
            >
              Demote
            </KBtn>
          )}
          <KBtn
            variant="danger"
            onClick={() => setConfirmDelete(true)}
            disabled={isMe}
            title={isMe ? "you can't delete yourself" : "delete user"}
          >
            Delete
          </KBtn>
        </div>

        <Modal
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title={`Delete user "${user.email}"?`}
          description="The user will be signed out everywhere. Their personal logins, memory entries, and minted tokens are all removed."
          size="md"
          footer={
            <>
              <KBtn onClick={() => setConfirmDelete(false)}>Cancel</KBtn>
              <KBtn variant="danger" onClick={deleteUser}>
                Delete
              </KBtn>
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
              <KBtn onClick={() => setConfirmRole(null)}>Cancel</KBtn>
              <KBtn
                variant="primary"
                onClick={() => confirmRole && setRole(confirmRole.to)}
              >
                {confirmRole?.to === "admin" ? "Promote" : "Demote"}
              </KBtn>
            </>
          }
        />
      </td>
    </tr>
  );
}
