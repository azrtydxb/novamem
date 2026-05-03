import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, MinusCircle, RefreshCw, XCircle } from "lucide-react";
import { api, type HealthSnapshot } from "../lib/api";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/Card";
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
  const { data, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const r = await api<HealthSnapshot>("GET", "/health");
      if (!r.ok || !r.body) throw new Error(r.error ?? `health ${r.status}`);
      return r.body;
    },
    refetchInterval: POLL_MS,
  });

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
          <span>last checked {fmtRelative(new Date(dataUpdatedAt).toISOString())}</span>
          <Button size="sm" variant="ghost" onClick={() => void refetch()} loading={isFetching}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <div>
            <CardTitle>Overall status</CardTitle>
            <CardDescription>Aggregate of warm + cold liveness probes.</CardDescription>
          </div>
          {data ? (
            data.ok ? (
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
                {statusBadge(data?.deps?.[d.key])}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
