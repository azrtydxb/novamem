import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, AuditEntry } from "../lib/api";
import { KCard } from "../components/k/KCard";
import { KHeader } from "../components/k/KHeader";
import { KEmpty } from "../components/k/KEmpty";
import { KPill } from "../components/k/KPill";
import { KBtn } from "../components/k/KBtn";
import { cn } from "../lib/utils";

interface Resp {
  entries: AuditEntry[];
}

/** Colour by what the action *does*, which the action name states
 *  outright — not by an invented severity. `user.ban` and `user.remove`
 *  are destructive; `*.add` / `*.create` are additive; everything else
 *  is a plain change. */
function toneFor(action: string): "err" | "graph" | "dim" {
  if (/\.(ban|remove|delete|revoke)$/.test(action)) return "err";
  if (/\.(add|create|invite)$/.test(action)) return "graph";
  return "dim";
}

/** Flatten the JSONB metadata into one readable line. Rendering the raw
 *  object is unreadable at table width, and dropping it loses the only
 *  record of *what* changed (old role → new role, and so on). */
function detailOf(e: AuditEntry): string {
  const parts: string[] = [];
  if (e.target) parts.push(e.target);
  for (const [k, v] of Object.entries(e.metadata ?? {})) {
    if (v === null || v === undefined || v === "") continue;
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(" · ");
}

/** Admin audit log — `GET /v1/admin/audit-log`.
 *
 *  Deliberately has no severity column: the server records no such
 *  field, and deriving info/warn/err from the action string would be
 *  presenting a guess as a recorded fact. */
export function AuditPage() {
  const [limit, setLimit] = useState(200);
  const [filter, setFilter] = useState("");

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["audit-log", limit],
    queryFn: async () => {
      const r = await api<Resp>("GET", `/v1/admin/audit-log?limit=${limit}`);
      if (!r.ok || !r.body) throw new Error(r.error ?? `audit ${r.status}`);
      return r.body;
    },
    refetchInterval: 30_000,
  });

  const entries = data?.entries ?? [];
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) =>
      [e.actorLabel, e.action, detailOf(e), e.requestIp ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [entries, filter]);

  return (
    <div className="p-6">
      <KHeader
        crumb="operations"
        title="Audit log"
        right={
          <>
            <KPill tone="dim">
              {shown.length}
              {shown.length !== entries.length ? ` / ${entries.length}` : ""}
            </KPill>
            <KBtn onClick={() => void refetch()} loading={isFetching}>
              Refresh
            </KBtn>
          </>
        }
      />

      <KCard
        title="admin actions"
        right={
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            aria-label="Filter audit entries"
            className="w-40 rounded-sm border border-rule-soft bg-input px-2 py-1 font-mono text-[11px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
        }
      >
        {error ? (
          <KEmpty
            glyph="⚠"
            title="Could not load the audit log"
            hint={(error as Error).message}
            action={<KBtn onClick={() => void refetch()}>Retry</KBtn>}
          />
        ) : shown.length === 0 ? (
          <KEmpty
            title={entries.length === 0 ? "No audit entries yet" : "No matches"}
            hint={
              entries.length === 0
                ? "Admin actions — role changes, project membership, user creation — are recorded here as they happen."
                : "Nothing in the loaded window matches that filter."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  {["when", "actor", "action", "detail", "ip"].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-2 font-mono text-[9.5px] font-normal uppercase tracking-[0.14em] text-faint-2"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-rule-soft last:border-0 hover:bg-subtle/50"
                  >
                    <td
                      className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-faint tabular-nums"
                      title={e.ts}
                    >
                      {new Date(e.ts).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-[12px] text-ink-2">
                      {e.actorLabel}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          "font-mono text-[11px]",
                          toneFor(e.action) === "err"
                            ? "text-err"
                            : toneFor(e.action) === "graph"
                            ? "text-graph"
                            : "text-dim"
                        )}
                      >
                        {e.action}
                      </span>
                    </td>
                    <td className="max-w-[420px] truncate px-4 py-2 font-mono text-[11px] text-dim">
                      {detailOf(e) || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-faint">
                      {e.requestIp ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </KCard>

      {/* The endpoint caps at 500. Saying so beats a button that silently
          stops widening the window. */}
      <div className="mt-3 flex items-center gap-2 font-mono text-[10.5px] text-faint">
        <span>showing the newest {limit}</span>
        {limit < 500 ? (
          <button
            onClick={() => setLimit(500)}
            className="text-link hover:underline"
          >
            load 500 (server maximum)
          </button>
        ) : (
          <span>— the server's maximum</span>
        )}
      </div>
    </div>
  );
}
