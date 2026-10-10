import { useQuery } from "@tanstack/react-query";
import { KCard } from "../components/k/KCard";
import { KEmpty } from "../components/k/KEmpty";
import { KHeader } from "../components/k/KHeader";
import { KStat } from "../components/k/KStat";
import { KPill } from "../components/k/KPill";
import { api, type TelemetrySnapshot } from "../lib/api";
import { useAuth } from "../lib/auth-context";

function CountTable({ title, rows }: { title: string; rows: { key: string; count: number }[] }) {
  return <KCard title={title}>
    {rows.length === 0 ? <KEmpty title="No aggregate data" /> :
      <table className="w-full text-left text-xs"><tbody>{rows.map((row) =>
        <tr key={row.key} className="border-b border-rule last:border-0">
          <th className="px-4 py-2.5 font-mono font-normal text-dim">{row.key}</th>
          <td className="px-4 py-2.5 text-right font-mono tabnum text-ink">{row.count.toLocaleString()}</td>
        </tr>)}</tbody></table>}
  </KCard>;
}

export function TelemetryPage() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["admin-telemetry", user?.id],
    queryFn: async () => {
      const response = await api<TelemetrySnapshot>("GET", "/v1/admin/telemetry");
      if (!response.body) throw new Error(`telemetry ${response.status}`);
      return response.body;
    },
  });
  return <div className="p-6">
    <KHeader title="Memory telemetry" crumb="aggregate · last 30 days" />
    {query.isLoading ? <div role="status" className="py-16 text-center font-mono text-sm text-faint">Loading telemetry…</div> : null}
    {query.isError ? <KCard><KEmpty title="Telemetry unavailable" hint={(query.error as Error).message} /></KCard> : null}
    {query.data ? <>
      {query.data.totalEntries === 0 ? <KCard><KEmpty title="No memory entries yet" hint="Aggregate statistics will appear after memories are stored." /></KCard> : null}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KStat label="entries" value={query.data.totalEntries.toLocaleString()} />
        <KStat label="embedded" value={query.data.embeddedEntries.toLocaleString()} tone="warm" />
        <KStat label="pending embeddings" value={query.data.pendingEmbeddings.toLocaleString()} tone={query.data.pendingEmbeddings ? "err" : "warm"} />
        <KStat label="pending extractions" value={query.data.pendingExtractions.toLocaleString()} />
        <KStat label="pending cold orphans" value={query.data.pendingColdOrphans.toLocaleString()} tone={query.data.pendingColdOrphans ? "err" : "warm"} />
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <CountTable title="entries by namespace" rows={query.data.byNamespace} />
        <CountTable title="entries by project id" rows={query.data.byProject} />
        <CountTable title="entries by sensitivity · 30 days" rows={query.data.bySensitivity} />
        <CountTable title="entries by tier" rows={query.data.byTier} />
        <CountTable title="top agents" rows={query.data.topAgents.map((a) => ({ key: a.name, count: a.count }))} />
        <KCard title="service and jobs" padded>
          <div className="flex flex-wrap gap-2">{Object.entries(query.data.health.deps).map(([name, state]) =>
            <KPill key={name} tone={state === "ok" ? "warm" : "err"}>{name}: {state}</KPill>)}</div>
          <p className="mt-3 text-xs text-faint">Last decay run: {query.data.lastDecayAt ? new Date(query.data.lastDecayAt).toLocaleString() : "not recorded"}</p>
        </KCard>
      </div>
      <KCard title="entries created per day · 30 days">
        <div className="max-h-72 overflow-auto"><table className="w-full text-left text-xs"><tbody>{query.data.createdPerDay.map((day) =>
          <tr key={day.date} className="border-b border-rule last:border-0"><th className="px-4 py-2 font-mono font-normal text-dim">{day.date}</th><td className="px-4 py-2 text-right font-mono tabnum text-ink">{day.count.toLocaleString()}</td></tr>)}</tbody></table></div>
      </KCard>
    </> : null}
  </div>;
}
