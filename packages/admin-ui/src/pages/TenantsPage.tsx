import { FormEvent, useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldOff,
  Trash2,
  Users,
} from "lucide-react";
import { api, Tenant, TenantToken } from "../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/Card";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { fmtTimestamp, fmtRelative, shortHash } from "../lib/utils";

export function TenantsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tenantModeUnavailable, setTenantModeUnavailable] = useState(false);

  const { data, isFetching, refetch } = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => {
      const r = await api<{ tenants: Tenant[] }>("GET", "/v1/admin/tenants");
      if (r.status === 404 || r.status === 400 || r.status === 501) {
        return { tenants: [], unavailable: true };
      }
      if (!r.ok || !r.body) throw new Error(r.error ?? `tenants ${r.status}`);
      return { tenants: r.body.tenants, unavailable: false };
    },
  });

  useEffect(() => {
    if (data?.unavailable) setTenantModeUnavailable(true);
  }, [data?.unavailable]);

  const tenants = data?.tenants ?? null;
  const busy = isFetching;
  const refresh = () => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Tenants</h1>
          <p className="text-sm text-dim mt-1">
            Manage tenants and their bearer tokens.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </header>

      {tenantModeUnavailable ? (
        <Card>
          <CardContent className="flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-warn flex-none" />
            <div className="text-sm text-dim">
              <span className="text-ink font-medium">Tenant mode is not active. </span>
              Set <code className="text-accent">NOVAMEM_AUTH_MODE=tenant</code> and restart the
              server to enable tenant CRUD. Health and Metrics still work without it.
            </div>
          </CardContent>
        </Card>
      ) : (
        <CreateTenantCard
          onCreated={() => {
            refresh();
            toast.success("Tenant created");
          }}
        />
      )}

      <div className="space-y-3">
        {tenants === null ? (
          <Card className="p-8 text-center text-sm text-dim">Loading tenants…</Card>
        ) : tenants.length === 0 ? (
          <Card className="p-12 text-center">
            <Users className="h-8 w-8 text-faint mx-auto mb-3" />
            <div className="text-sm text-ink font-medium">No tenants yet</div>
            <div className="text-xs text-dim mt-1">
              {tenantModeUnavailable
                ? "Tenant mode is disabled — switch the server to tenant mode to create tenants."
                : "Create your first tenant above to get started."}
            </div>
          </Card>
        ) : (
          tenants.map((t) => (
            <TenantRow
              key={t.id}
              tenant={t}
              disabled={tenantModeUnavailable}
              onChange={refresh}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Create ────────────────────────────────────────────────────────────

function CreateTenantCard({ onCreated }: { onCreated: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api("POST", "/v1/admin/tenants", { id: id.trim(), name: name.trim() });
    setBusy(false);
    if (r.ok) {
      setId("");
      setName("");
      onCreated();
    } else {
      const msg = r.error ?? `status ${r.status}`;
      setError(msg);
      toast.error("Could not create tenant", msg);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create tenant</CardTitle>
        <CardDescription>
          IDs are URL-safe slugs (lowercase, alphanumeric, dash, underscore).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <Input
            name="tenant_id"
            label="Tenant ID"
            placeholder="acme"
            value={id}
            onChange={(e) => setId(e.target.value)}
            error={error ?? undefined}
          />
          <Input
            name="tenant_name"
            label="Display name"
            placeholder="Acme Corp"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!id.trim() || !name.trim()}
          >
            <Plus className="h-3.5 w-3.5" /> Create
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Single tenant row ─────────────────────────────────────────────────

function TenantRow({
  tenant,
  disabled,
  onChange,
}: {
  tenant: Tenant;
  disabled: boolean;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<TenantToken[] | null>(null);
  const [mintedPlaintext, setMintedPlaintext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<TenantToken | null>(null);
  const toast = useToast();

  const loadTokens = useCallback(async () => {
    const r = await api<{ tokens: TenantToken[] }>(
      "GET",
      `/v1/admin/tenants/${encodeURIComponent(tenant.id)}/tokens`,
    );
    if (r.body) setTokens(r.body.tokens);
  }, [tenant.id]);

  useEffect(() => {
    if (open) void loadTokens();
  }, [open, loadTokens]);

  const mint = async () => {
    setBusy(true);
    const r = await api<{ token: string }>(
      "POST",
      `/v1/admin/tenants/${encodeURIComponent(tenant.id)}/tokens`,
      { label: "minted from dashboard" },
    );
    setBusy(false);
    if (r.ok && r.body?.token) {
      setMintedPlaintext(r.body.token);
      setOpen(true);
      void loadTokens();
    } else {
      toast.error("Mint failed", r.error ?? `status ${r.status}`);
    }
  };

  const revoke = async (hash: string) => {
    setConfirmRevoke(null);
    const r = await api(
      "POST",
      `/v1/admin/tenants/${encodeURIComponent(tenant.id)}/tokens/${hash}/revoke`,
    );
    if (r.ok) {
      toast.success("Token revoked");
      void loadTokens();
    } else {
      toast.error("Revoke failed", r.error ?? `status ${r.status}`);
    }
  };

  const deleteTenant = async () => {
    setConfirmDelete(false);
    setDeleteTyped("");
    setBusy(true);
    const r = await api<{ entriesRemoved: number; coldCollectionsDropped: string[] }>(
      "DELETE",
      `/v1/admin/tenants/${encodeURIComponent(tenant.id)}`,
    );
    setBusy(false);
    if (r.ok) {
      toast.success(
        `Tenant "${tenant.id}" deleted`,
        `purged ${r.body?.entriesRemoved ?? 0} entries, dropped ${r.body?.coldCollectionsDropped?.length ?? 0} collections`,
      );
      onChange();
    } else {
      toast.error("Delete failed", r.error ?? `status ${r.status}`);
    }
  };

  const isPublic = tenant.id === "public";

  return (
    <Card>
      <div
        className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-hover/40"
        onClick={() => setOpen(!open)}
      >
        <button
          className="text-faint hover:text-ink"
          aria-label={open ? "collapse" : "expand"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-ink">{tenant.id}</span>
            {isPublic && <Badge tone="neutral">system</Badge>}
          </div>
          <div className="text-xs text-dim mt-0.5 truncate">
            {tenant.name} · created {fmtRelative(tenant.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="secondary" onClick={mint} disabled={disabled || busy}>
            <KeyRound className="h-3.5 w-3.5" /> Mint token
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirmDelete(true)}
            disabled={disabled || busy || isPublic}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      </div>

      {open && (
        <div className="border-t border-rule">
          {mintedPlaintext && (
            <NewTokenBanner
              token={mintedPlaintext}
              onDismiss={() => setMintedPlaintext(null)}
            />
          )}
          <div className="p-5">
            <TokenTable
              tokens={tokens}
              onRevoke={(t) => setConfirmRevoke(t)}
              loading={tokens === null}
            />
          </div>
        </div>
      )}

      {/* Modals — render at the root so parent click targets stay clean. */}
      <Modal
        open={confirmDelete}
        onClose={() => {
          setConfirmDelete(false);
          setDeleteTyped("");
        }}
        title={`Delete tenant "${tenant.id}"?`}
        description={
          <>
            This will permanently remove every memory, vector, graph node, and bearer token
            owned by this tenant.{" "}
            <span className="text-err font-medium">This cannot be undone.</span>
          </>
        }
        size="md"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmDelete(false);
                setDeleteTyped("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={deleteTenant}
              disabled={deleteTyped !== tenant.id}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete tenant
            </Button>
          </>
        }
      >
        <Input
          label={`Type "${tenant.id}" to confirm`}
          value={deleteTyped}
          onChange={(e) => setDeleteTyped(e.target.value)}
          placeholder={tenant.id}
          autoFocus
        />
      </Modal>

      <Modal
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke token?"
        description={
          confirmRevoke ? (
            <>
              The token <code className="text-ink font-mono">{shortHash(confirmRevoke.tokenHash)}</code>{" "}
              will stop working immediately. Active clients will receive 401s on their next request.
            </>
          ) : null
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRevoke(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => confirmRevoke && revoke(confirmRevoke.tokenHash)}
            >
              <ShieldOff className="h-3.5 w-3.5" /> Revoke
            </Button>
          </>
        }
      />
    </Card>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

function NewTokenBanner({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  return (
    <div className="border-b border-warn/40 bg-warn-soft/40 px-5 py-4 space-y-3 animate-fade-in">
      <div className="flex items-start gap-2">
        <KeyRound className="h-4 w-4 mt-0.5 text-warn" />
        <div className="flex-1">
          <div className="text-sm font-medium text-ink">New token — shown once</div>
          <div className="text-xs text-dim">
            The server keeps only a sha256 hash. Copy this token and store it now.
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 px-3 py-2 rounded-md bg-bg text-dim font-mono text-xs break-all border border-rule">
          {token}
        </code>
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(token);
              setCopied(true);
              toast.success("Token copied to clipboard");
              setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error("Could not access clipboard");
            }
          }}
        >
          <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function TokenTable({
  tokens,
  onRevoke,
  loading,
}: {
  tokens: TenantToken[] | null;
  onRevoke: (t: TenantToken) => void;
  loading: boolean;
}) {
  if (loading) return <div className="text-sm text-dim py-4">Loading tokens…</div>;
  if (!tokens || tokens.length === 0)
    return <div className="text-sm text-dim py-4">No tokens yet — click "Mint token" above.</div>;

  return (
    <div className="border border-rule rounded-md overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-subtle/60">
          <tr className="text-dim text-[11px] uppercase tracking-wider">
            <th className="text-left font-medium px-4 py-2.5">Hash</th>
            <th className="text-left font-medium px-4 py-2.5">Label</th>
            <th className="text-left font-medium px-4 py-2.5">Created</th>
            <th className="text-left font-medium px-4 py-2.5">Last used</th>
            <th className="text-left font-medium px-4 py-2.5">Status</th>
            <th className="text-right font-medium px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tokens.map((t) => (
            <tr key={t.tokenHash} className="text-ink">
              <td className="px-4 py-3">
                <span className="font-mono text-xs" title={t.tokenHash}>
                  {shortHash(t.tokenHash)}
                </span>
              </td>
              <td className="px-4 py-3 text-dim">{t.label ?? "—"}</td>
              <td className="px-4 py-3 font-mono text-xs text-dim">
                {fmtTimestamp(t.createdAt)}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-dim">
                {t.lastUsedAt ? fmtTimestamp(t.lastUsedAt) : <span className="text-faint">never</span>}
              </td>
              <td className="px-4 py-3">
                {t.revoked ? (
                  <Badge tone="danger">revoked</Badge>
                ) : (
                  <Badge tone="success">active</Badge>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                {!t.revoked && (
                  <Button size="sm" variant="ghost" onClick={() => onRevoke(t)}>
                    <ShieldOff className="h-3.5 w-3.5" /> Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

