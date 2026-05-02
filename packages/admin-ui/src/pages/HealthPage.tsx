import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, MinusCircle, RefreshCw } from "lucide-react";
import { api, HealthSnapshot } from "../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/Card";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { fmtRelative } from "../lib/utils";

const POLL_MS = 5000;

const DEPS: Array<{ key: keyof HealthSnapshot["deps"]; name: string; system: string }> = [
  { key: "warm", name: "Warm tier", system: "Postgres" },
  { key: "cold", name: "Cold tier", system: "Qdrant" },
  { key: "graph", name: "Graph", system: "FalkorDB" },
];

function statusBadge(s: string | undefined) {
  if (s === "ok")
    return (
      <Badge tone="success">
        <CheckCircle2 className="h-3 w-3" /> healthy
      </Badge>
    );
  if (s === "disabled")
    return (
      <Badge tone="neutral">
        <MinusCircle className="h-3 w-3" /> disabled
      </Badge>
    );
  return (
    <Badge tone="danger">
      <XCircle className="h-3 w-3" /> unreachable
    </Badge>
  );
}

export function HealthPage() {
  const [snap, setSnap] = useState<HealthSnapshot | null>(null);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    const r = await api<HealthSnapshot>("GET", "/health");
    if (r.body) setSnap(r.body);
    setLastAt(new Date().toISOString());
    setBusy(false);
  };

  useEffect(() => {
    void load();
    const id = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text">Health</h1>
          <p className="text-sm text-text-muted mt-1">
            Liveness and dependency status, polled every {POLL_MS / 1000}s.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span>last checked {fmtRelative(lastAt)}</span>
          <Button size="sm" variant="ghost" onClick={load} loading={busy}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <div>
            <CardTitle>Overall status</CardTitle>
            <CardDescription>
              Aggregate of warm + cold liveness probes.
            </CardDescription>
          </div>
          {snap ? (
            snap.ok ? (
              <Badge tone="success">
                <CheckCircle2 className="h-3 w-3" /> healthy
              </Badge>
            ) : (
              <Badge tone="danger">
                <XCircle className="h-3 w-3" /> degraded
              </Badge>
            )
          ) : (
            <Badge tone="neutral">…</Badge>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {DEPS.map((d) => (
              <div key={d.key} className="flex items-center justify-between px-5 py-4">
                <div>
                  <div className="text-sm font-medium text-text">{d.name}</div>
                  <div className="text-xs text-text-muted">{d.system}</div>
                </div>
                {statusBadge(snap?.deps?.[d.key])}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
