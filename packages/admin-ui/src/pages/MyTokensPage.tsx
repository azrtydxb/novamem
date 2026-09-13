import { FormEvent, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import { api, UserToken } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/Card";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { KHeader } from "../components/k/KHeader";
import { useToast } from "../components/Toast";
import { fmtRelative, fmtTimestamp, shortHash } from "../lib/utils";

export function MyTokensPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const tokensQ = useQuery({
    queryKey: ["me", "tokens"],
    queryFn: async () => {
      const r = await api<{ tokens: UserToken[] }>("GET", "/v1/me/tokens");
      if (!r.ok || !r.body) throw new Error(r.error ?? `tokens ${r.status}`);
      return r.body.tokens;
    },
  });
  const tokens: UserToken[] | null = tokensQ.data ?? null;
  // A revoked token is not a credential — it cannot authenticate anything.
  // The table listed them identically to live ones, so a user who had run
  // the conformance suite a few times was shown a hundred "API tokens"
  // when five worked. The rows are real history, so they are kept behind a
  // disclosure rather than hidden outright.
  const live = tokens?.filter((t) => !t.revoked) ?? null;
  const revoked = tokens?.filter((t) => t.revoked) ?? [];
  const [showRevoked, setShowRevoked] = useState(false);
  const busy = tokensQ.isFetching;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["me", "tokens"] });
  };

  const [createdPlaintext, setCreatedPlaintext] = useState<{
    token: string;
    label: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserToken | null>(null);
  const toast = useToast();

  const remove = async (hash: string) => {
    const r = await api("DELETE", `/v1/me/tokens/${hash}`);
    setConfirmDelete(null);
    if (r.ok) {
      toast.success("Token deleted");
      void refresh();
    } else {
      toast.error("Delete failed", r.error ?? `status ${r.status}`);
    }
  };

  return (
    <div className="p-6">
      <KHeader
        crumb="per-device · plaintext shown once"
        title="API tokens"
        right={
          <>
            {user?.username ? (
              <Badge tone="accent">{user.username}</Badge>
            ) : null}
            <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />
      <p className="mb-4 max-w-3xl text-xs leading-relaxed text-dim">
        One token per device or agent. The plaintext is shown only at creation —
        store it then; the server keeps just a sha256 hash.
      </p>
      <div className="space-y-3">
        <CreateCard
          onCreated={(token, label) => {
            setCreatedPlaintext({ token, label });
            void refresh();
          }}
        />

        {tokens === null ? (
          <Card className="p-8 text-center text-sm text-dim">
            Loading tokens…
          </Card>
        ) : live!.length === 0 ? (
          <Card className="p-12 text-center">
            <KeyRound className="h-8 w-8 text-faint mx-auto mb-3" />
            <div className="text-sm text-ink font-medium">
              {revoked.length > 0 ? "No live tokens" : "No tokens yet"}
            </div>
            <div className="text-xs text-dim mt-1">
              {revoked.length > 0
                ? `Create one above. ${revoked.length} revoked ${
                    revoked.length === 1 ? "token is" : "tokens are"
                  } listed below.`
                : "Create one above to start authenticating a device."}
            </div>
          </Card>
        ) : (
          <Card>
            <div className="overflow-hidden rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-subtle/60">
                  <tr className="text-dim text-[11px] uppercase tracking-wider">
                    <th className="text-left font-medium px-4 py-2.5">
                      Device
                    </th>
                    <th className="text-left font-medium px-4 py-2.5">Hash</th>
                    <th className="text-left font-medium px-4 py-2.5">
                      Created
                    </th>
                    <th className="text-left font-medium px-4 py-2.5">
                      Last used
                    </th>
                    <th className="text-right font-medium px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {live!.map((t) => (
                    <tr key={t.tokenHash}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Smartphone className="h-3.5 w-3.5 text-faint" />
                          <span className="text-ink">
                            {t.label || (
                              <span className="text-faint">unlabeled</span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td
                        className="px-4 py-3 font-mono text-xs text-dim"
                        title={t.tokenHash}
                      >
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
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(t)}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {revoked.length > 0 ? (
          <div>
            <button
              onClick={() => setShowRevoked((v) => !v)}
              className="font-mono text-[11px] text-faint hover:text-ink transition-colors"
            >
              {showRevoked ? "▾" : "▸"} {revoked.length} revoked{" "}
              {revoked.length === 1 ? "token" : "tokens"}
            </button>
            {showRevoked ? (
              <Card className="mt-2">
                {revoked.map((t) => (
                  <div
                    key={t.tokenHash}
                    className="flex items-center gap-3 border-b border-rule-soft px-4 py-2.5 last:border-0"
                  >
                    <Badge tone="neutral">revoked</Badge>
                    <span className="text-[12.5px] text-dim">
                      {t.label || "unlabeled"}
                    </span>
                    <span
                      className="font-mono text-[10.5px] text-faint"
                      title={t.tokenHash}
                    >
                      {shortHash(t.tokenHash)}
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] text-faint">
                      created {fmtTimestamp(t.createdAt)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(t)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                ))}
              </Card>
            ) : null}
          </div>
        ) : null}

        {/* Created result modal — full plaintext, prominent Copy button */}
        <Modal
          open={!!createdPlaintext}
          onClose={() => setCreatedPlaintext(null)}
          title="New token"
          size="lg"
          description={
            <>
              This is the only time you'll see the plaintext.{" "}
              <span className="text-warn font-medium">Copy it now</span> and
              store it on your device — the server keeps only a sha256 hash.
            </>
          }
          footer={
            <Button variant="primary" onClick={() => setCreatedPlaintext(null)}>
              Done
            </Button>
          }
        >
          {createdPlaintext ? (
            <div className="space-y-3">
              <div className="text-xs text-dim">
                Label:{" "}
                <span className="text-ink font-medium">
                  {createdPlaintext.label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded-md bg-bg text-ink font-mono text-xs break-all border border-rule">
                  {createdPlaintext.token}
                </code>
                <CopyButton value={createdPlaintext.token} />
              </div>
            </div>
          ) : null}
        </Modal>

        {/* Delete confirm */}
        <Modal
          open={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          title="Delete this token?"
          description={
            confirmDelete ? (
              <>
                <span className="text-ink font-medium">
                  {confirmDelete.label || "(unlabeled)"}
                </span>{" "}
                <code className="font-mono text-xs">
                  {shortHash(confirmDelete.tokenHash)}
                </code>{" "}
                will stop working immediately. The device using it will receive
                401s. This is irreversible.
              </>
            ) : null
          }
          size="sm"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => confirmDelete && remove(confirmDelete.tokenHash)}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}

function CreateCard({
  onCreated,
}: {
  onCreated: (token: string, label: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const finalLabel = label.trim() || "device";
    const r = await api<{ token: string }>("POST", "/v1/me/tokens", {
      label: finalLabel,
    });
    setBusy(false);
    if (r.ok && r.body?.token) {
      onCreated(r.body.token, finalLabel);
      setLabel("");
    } else {
      toast.error("Create failed", r.error ?? `status ${r.status}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create token</CardTitle>
        <CardDescription>
          A token belongs to one device or agent. Anything authenticated with it
          can read and write your memory.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={submit}
          className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end"
        >
          <Input
            name="label"
            label="Device label"
            placeholder="laptop"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={busy}>
            <Plus className="h-3.5 w-3.5" /> Create
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Copy `value` to the clipboard. The Clipboard API only works in a
 *  secure context (HTTPS or localhost) — over plain HTTP (e.g. the
 *  k3s LoadBalancer at http://<host>:7778) navigator.clipboard is
 *  undefined, so we fall back to the legacy execCommand path which
 *  works regardless of context. */
async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  return (
    <Button
      variant="primary"
      onClick={async () => {
        const ok = await copyToClipboard(value);
        if (ok) {
          setCopied(true);
          toast.success("Copied to clipboard");
          setTimeout(() => setCopied(false), 1500);
        } else {
          toast.error("Could not access clipboard");
        }
      }}
    >
      <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
    </Button>
  );
}
