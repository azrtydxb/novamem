import { FormEvent, useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FolderKanban,
  FolderPlus,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users as UsersIcon,
} from "lucide-react";
import { api, Project, ProjectMember } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/Card";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { fmtRelative } from "../lib/utils";

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const { data: projects = null, isFetching: busy } = useQuery({
    queryKey: ["me", "projects"],
    queryFn: async () => {
      const r = await api<{ projects: Project[] }>("GET", "/v1/me/projects");
      if (!r.ok || !r.body) throw new Error(r.error ?? `projects ${r.status}`);
      return r.body.projects;
    },
  });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["me", "projects"] });
  }, [queryClient]);

  return (
    <>
      <PageHeader
        kicker="Sub-brains · scoped memory"
        title="Projects"
        subtitle="A project is a sub-brain — its memories live separately from your tenant-wide entries. Share with another user (any tenant) by adding them as a member."
        actions={
          <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />
      <div className="p-5 space-y-3">
      <CreateProjectCard onCreated={refresh} />

      {projects === null ? (
        <Card className="p-8 text-center text-sm text-dim">Loading projects…</Card>
      ) : projects.length === 0 ? (
        <Card className="p-12 text-center">
          <FolderKanban className="h-8 w-8 text-faint mx-auto mb-3" />
          <div className="text-sm text-ink font-medium">No projects yet</div>
          <div className="text-xs text-dim mt-1">
            Create your first project above to start a fresh sub-brain.
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} onChange={refresh} />
          ))}
        </div>
      )}
      </div>
    </>
  );
}

function CreateProjectCard({ onCreated }: { onCreated: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api("POST", "/v1/me/projects", { id: id.trim(), name: name.trim() });
    setBusy(false);
    if (r.ok) {
      toast.success(`Project "${id}" created`);
      setId("");
      setName("");
      onCreated();
    } else {
      const msg = r.error ?? `status ${r.status}`;
      setError(msg);
      toast.error("Could not create project", msg);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create project</CardTitle>
        <CardDescription>
          Use a slug for the id (alphanumeric / dot / underscore / dash). You become the owner.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <Input
            name="project_id"
            label="Project ID"
            placeholder="phoenix"
            value={id}
            onChange={(e) => setId(e.target.value)}
            error={error ?? undefined}
          />
          <Input
            name="project_name"
            label="Display name"
            placeholder="Phoenix"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!id.trim() || !name.trim()}
          >
            <FolderPlus className="h-3.5 w-3.5" /> Create
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ProjectRow({ project, onChange }: { project: Project; onChange: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ProjectMember | null>(null);
  const [deleteTyped, setDeleteTyped] = useState("");
  const toast = useToast();

  const isOwner = user?.id === project.ownerUserId;

  const loadMembers = useCallback(async () => {
    const r = await api<{ members: ProjectMember[] }>(
      "GET",
      `/v1/me/projects/${encodeURIComponent(project.id)}/members`,
    );
    if (r.body) setMembers(r.body.members);
  }, [project.id]);

  useEffect(() => {
    if (open) void loadMembers();
  }, [open, loadMembers]);

  const deleteProject = async () => {
    setConfirmDelete(false);
    setDeleteTyped("");
    const r = await api<{ entriesRemoved: number }>(
      "DELETE",
      `/v1/me/projects/${encodeURIComponent(project.id)}`,
    );
    if (r.ok) {
      toast.success(
        `Project "${project.id}" deleted`,
        `purged ${r.body?.entriesRemoved ?? 0} entries`,
      );
      onChange();
    } else {
      toast.error("Delete failed", r.error ?? `status ${r.status}`);
    }
  };

  const leave = async () => {
    setConfirmLeave(false);
    if (!user) return;
    const r = await api(
      "DELETE",
      `/v1/me/projects/${encodeURIComponent(project.id)}/members/${user.id}`,
    );
    if (r.ok) {
      toast.success(`Left "${project.id}"`);
      onChange();
    } else {
      toast.error("Could not leave", r.error ?? `status ${r.status}`);
    }
  };

  const removeMember = async (m: ProjectMember) => {
    setConfirmRemove(null);
    const r = await api(
      "DELETE",
      `/v1/me/projects/${encodeURIComponent(project.id)}/members/${m.userId}`,
    );
    if (r.ok) {
      toast.success(`${m.username} removed`);
      void loadMembers();
    } else {
      toast.error("Remove failed", r.error ?? `status ${r.status}`);
    }
  };

  return (
    <Card>
      <div
        className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-hover/40"
        onClick={() => setOpen(!open)}
      >
        <button className="text-faint hover:text-ink" aria-label={open ? "collapse" : "expand"}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <FolderKanban className="h-4 w-4 text-accent" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-ink">{project.id}</span>
            {isOwner ? (
              <Badge tone="accent">
                <ShieldCheck className="h-3 w-3" /> owner
              </Badge>
            ) : (
              <Badge tone="neutral">member</Badge>
            )}
          </div>
          <div className="text-xs text-dim mt-0.5 truncate">
            {project.name} · created {fmtRelative(project.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {isOwner ? (
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmLeave(true)}>
              <LogOut className="h-3.5 w-3.5" /> Leave
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-rule p-5 space-y-4">
          {isOwner && <AddMemberForm projectId={project.id} onAdded={loadMembers} />}
          <MemberTable
            members={members}
            isOwner={isOwner}
            ownerUserId={project.ownerUserId}
            onRemove={(m) => setConfirmRemove(m)}
          />
        </div>
      )}

      <Modal
        open={confirmDelete}
        onClose={() => {
          setConfirmDelete(false);
          setDeleteTyped("");
        }}
        title={`Delete project "${project.id}"?`}
        description={
          <>
            Every memory, vector, and graph node in this project is purged. Tokens scoped to this
            project are revoked.{" "}
            <span className="text-err font-medium">This cannot be undone.</span>
          </>
        }
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={deleteProject} disabled={deleteTyped !== project.id}>
              <Trash2 className="h-3.5 w-3.5" /> Delete project
            </Button>
          </>
        }
      >
        <Input
          label={`Type "${project.id}" to confirm`}
          value={deleteTyped}
          onChange={(e) => setDeleteTyped(e.target.value)}
          placeholder={project.id}
          autoFocus
        />
      </Modal>

      <Modal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={`Leave "${project.id}"?`}
        description="You'll lose access to this project's memories. The owner can re-add you any time."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmLeave(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={leave}>
              <LogOut className="h-3.5 w-3.5" /> Leave
            </Button>
          </>
        }
      />

      <Modal
        open={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        title={`Remove ${confirmRemove?.username}?`}
        description="They'll lose access to this project. You can re-add them later."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => confirmRemove && removeMember(confirmRemove)}>
              Remove
            </Button>
          </>
        }
      />
    </Card>
  );
}

function AddMemberForm({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await api(
      "POST",
      `/v1/me/projects/${encodeURIComponent(projectId)}/members`,
      { username: username.trim() },
    );
    setBusy(false);
    if (r.ok) {
      toast.success(`${username} added`);
      setUsername("");
      onAdded();
    } else {
      toast.error("Could not add member", r.error ?? `status ${r.status}`);
    }
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-[1fr_auto] gap-3 items-end">
      <Input
        name="add_member_username"
        label="Add a member by username"
        placeholder="carol"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <Button type="submit" variant="primary" loading={busy} disabled={!username.trim()}>
        <UserPlus className="h-3.5 w-3.5" /> Add
      </Button>
    </form>
  );
}

function MemberTable({
  members,
  isOwner,
  ownerUserId,
  onRemove,
}: {
  members: ProjectMember[] | null;
  isOwner: boolean;
  ownerUserId: string;
  onRemove: (m: ProjectMember) => void;
}) {
  if (members === null) return <div className="text-sm text-dim">Loading members…</div>;
  if (members.length === 0)
    return (
      <div className="text-sm text-dim flex items-center gap-2">
        <UsersIcon className="h-4 w-4 text-faint" /> No members yet.
      </div>
    );
  return (
    <div className="border border-rule rounded-md overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-subtle/60">
          <tr className="text-dim text-[11px] uppercase tracking-wider">
            <th className="text-left font-medium px-4 py-2.5">User</th>
            <th className="text-left font-medium px-4 py-2.5">Role</th>
            <th className="text-right font-medium px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {members.map((m) => (
            <tr key={m.userId}>
              <td className="px-4 py-3 font-medium text-ink">{m.username}</td>
              <td className="px-4 py-3">
                {m.role === "owner" ? (
                  <Badge tone="accent">
                    <ShieldCheck className="h-3 w-3" /> owner
                  </Badge>
                ) : (
                  <Badge tone="neutral">member</Badge>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                {isOwner && m.userId !== ownerUserId ? (
                  <Button size="sm" variant="ghost" onClick={() => onRemove(m)}>
                    Remove
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
