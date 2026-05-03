import { FormEvent, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, KeyRound, Plus, RefreshCw, ShieldOff, Smartphone } from "lucide-react";
import { api, Project, TenantToken } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/Card";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { fmtRelative, fmtTimestamp, shortHash } from "../lib/utils";

export function MyTokensPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const tokensQ = useQuery({
    queryKey: ["me", "tokens"],
    queryFn: async () => {
      const r = await api<{ tokens: TenantToken[] }>("GET", "/v1/me/tokens");
      if (!r.ok || !r.body) throw new Error(r.error ?? `tokens ${r.status}`);
      return r.body.tokens;
    },
  });
  const projectsQ = useQuery({
    queryKey: ["me", "projects"],
    queryFn: async () => {
      const r = await api<{ projects: Project[] }>("GET", "/v1/me/projects");
      if (!r.ok || !r.body) return [] as Project[];
      return r.body.projects;
    },
  });
  const tokens: TenantToken[] | null = tokensQ.data ?? null;
  const projects: Project[] = projectsQ.data ?? [];
  const busy = tokensQ.isFetching || projectsQ.isFetching;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["me", "tokens"] });
    void queryClient.invalidateQueries({ queryKey: ["me", "projects"] });
  };

  const [mintedPlaintext, setMintedPlaintext] = useState<{
    token: string;
    label: string;
    projectId: string | null;
  } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<TenantToken | null>(null);
  const toast = useToast();

  const revoke = async (hash: string) => {
    const r = await api("POST", `/v1/me/tokens/${hash}/revoke`);
    setConfirmRevoke(null);
    if (r.ok) {
      toast.success("Token revoked");
      void refresh();
    } else {
      toast.error("Revoke failed", r.error ?? `status ${r.status}`);
    }
  };

  return (
    <>
      <PageHeader
        kicker="Per-device · plaintext shown once"
        title={
          <div className="flex items-center gap-2">
            <span>API tokens</span>
            {user?.userId ? <Badge tone="accent">tenant: {user.userId}</Badge> : null}
          </div>
        }
        subtitle="Mint a token per device. Plaintext is shown once at mint — revoke and mint again if you lose it."
        actions={
          <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />
      <div className="p-5 space-y-3">
      <MintCard
        projects={projects}
        onMinted={(token, label, projectId) => {
          setMintedPlaintext({ token, label, projectId });
          void refresh();
        }}
      />

      {tokens === null ? (
        <Card className="p-8 text-center text-sm text-dim">Loading tokens…</Card>
      ) : tokens.length === 0 ? (
        <Card className="p-12 text-center">
          <KeyRound className="h-8 w-8 text-faint mx-auto mb-3" />
          <div className="text-sm text-ink font-medium">No tokens yet</div>
          <div className="text-xs text-dim mt-1">
            Mint one above to start authenticating a device.
          </div>
        </Card>
      ) : (
        <Card>
          <div className="overflow-hidden rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-subtle/60">
                <tr className="text-dim text-[11px] uppercase tracking-wider">
                  <th className="text-left font-medium px-4 py-2.5">Device</th>
                  <th className="text-left font-medium px-4 py-2.5">Scope</th>
                  <th className="text-left font-medium px-4 py-2.5">Hash</th>
                  <th className="text-left font-medium px-4 py-2.5">Created</th>
                  <th className="text-left font-medium px-4 py-2.5">Last used</th>
                  <th className="text-left font-medium px-4 py-2.5">Status</th>
                  <th className="text-right font-medium px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tokens.map((t) => (
                  <tr key={t.tokenHash}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Smartphone className="h-3.5 w-3.5 text-faint" />
                        <span className="text-ink">
                          {t.label || <span className="text-faint">unlabeled</span>}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {t.projectId ? (
                        <Badge tone="accent">project: {t.projectId}</Badge>
                      ) : (
                        <Badge tone="neutral">tenant-wide</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-dim" title={t.tokenHash}>
                      {shortHash(t.tokenHash)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-dim">
                      {fmtTimestamp(t.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-xs text-dim">
                      {t.lastUsedAt ? (
                        fmtRelative(t.lastUsedAt)
                      ) : (
                        <span className="text-faint">never</span>
                      )}
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
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(t)}>
                          <ShieldOff className="h-3.5 w-3.5" /> Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Mint result modal — full plaintext, prominent Copy button */}
      <Modal
        open={!!mintedPlaintext}
        onClose={() => setMintedPlaintext(null)}
        title="New token"
        size="lg"
        description={
          <>
            This is the only time you'll see the plaintext.{" "}
            <span className="text-warn font-medium">Copy it now</span> and store it on your
            device — the server keeps only a sha256 hash.
          </>
        }
        footer={
          <Button variant="primary" onClick={() => setMintedPlaintext(null)}>
            Done
          </Button>
        }
      >
        {mintedPlaintext ? (
          <div className="space-y-3">
            <div className="text-xs text-dim flex flex-wrap gap-x-4">
              <div>
                Label: <span className="text-ink font-medium">{mintedPlaintext.label}</span>
              </div>
              <div>
                Scope:{" "}
                {mintedPlaintext.projectId ? (
                  <span className="text-accent font-medium">project {mintedPlaintext.projectId}</span>
                ) : (
                  <span className="text-ink font-medium">tenant-wide</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-md bg-bg text-ink font-mono text-xs break-all border border-rule">
                {mintedPlaintext.token}
              </code>
              <CopyButton value={mintedPlaintext.token} />
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Revoke confirm */}
      <Modal
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke this token?"
        description={
          confirmRevoke ? (
            <>
              <span className="text-ink font-medium">{confirmRevoke.label || "(unlabeled)"}</span>{" "}
              <code className="font-mono text-xs">{shortHash(confirmRevoke.tokenHash)}</code> will
              stop working immediately. The device using it will receive 401s.
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
      </div>
    </>
  );
}

function MintCard({
  projects,
  onMinted,
}: {
  projects: Project[];
  onMinted: (token: string, label: string, projectId: string | null) => void;
}) {
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<string>(""); // "" = tenant-wide, else project id
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const finalLabel = label.trim() || "device";
    const projectId = scope || null;
    const r = await api<{ token: string }>("POST", "/v1/me/tokens", {
      label: finalLabel,
      projectId,
    });
    setBusy(false);
    if (r.ok && r.body?.token) {
      onMinted(r.body.token, finalLabel, projectId);
      setLabel("");
      setScope("");
    } else {
      toast.error("Mint failed", r.error ?? `status ${r.status}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mint new token</CardTitle>
        <CardDescription>
          Choose a scope: tenant-wide tokens see only tenant-wide entries; project tokens see one
          sub-brain.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={submit}
          className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 items-end"
        >
          <Input
            name="label"
            label="Device label"
            placeholder="laptop"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-dim">Scope</label>
            <div className="relative">
              <select
                name="scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="w-full md:w-56 h-9 appearance-none rounded-md border border-rule bg-panel pl-3 pr-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <option value="">tenant-wide (default)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    project: {p.id}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-faint pointer-events-none" />
            </div>
          </div>
          <Button type="submit" variant="primary" loading={busy}>
            <Plus className="h-3.5 w-3.5" /> Mint
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  return (
    <Button
      variant="primary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Copied to clipboard");
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not access clipboard");
        }
      }}
    >
      <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
    </Button>
  );
}
