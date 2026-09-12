import { useQuery } from "@tanstack/react-query";
import { api, MetricsSnapshot, UserMetricsSnapshot } from "./api";
import { useAuth } from "./auth-context";

/** Admins fetch the global snapshot, which carries lifecycle counters and
 *  the orphans gauge; users fetch a user-scoped one, which omits them
 *  because decay and promotions are cross-user. */
export type AnySnapshot =
  | { kind: "admin"; data: MetricsSnapshot }
  | { kind: "user"; data: UserMetricsSnapshot };

export function isAdminSnapshot(
  s: AnySnapshot
): s is { kind: "admin"; data: MetricsSnapshot } {
  return s.kind === "admin";
}

/** Both callers use this endpoint on purpose. `/v1/me/metrics` returns
 *  global counters to an admin and user-scoped ones to everyone else, and
 *  it is the only endpoint that also returns the per-token series the
 *  Overview chart draws. `/v1/admin/metrics` still exists for Prometheus
 *  and scripts. */
export const METRICS_ENDPOINT = "/v1/me/metrics";
export const METRICS_KEY = ["metrics", METRICS_ENDPOINT] as const;

export const METRICS_POLL_MS = 5000;

/** One metrics query, shared by the Overview page and the sidebar's store
 *  counts.
 *
 *  This is a hook rather than two `useQuery` calls because they would
 *  share a key while returning different shapes: whichever mounted first
 *  would define the cache entry, and the other would read fields that are
 *  not there. Same key, same queryFn, one request. */
export function useMetricsSnapshot() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  return useQuery({
    queryKey: METRICS_KEY,
    queryFn: async (): Promise<AnySnapshot> => {
      const r = await api<MetricsSnapshot | UserMetricsSnapshot>(
        "GET",
        METRICS_ENDPOINT
      );
      if (!r.body) throw new Error("metrics: empty body");
      return isAdmin
        ? { kind: "admin", data: r.body as MetricsSnapshot }
        : { kind: "user", data: r.body as UserMetricsSnapshot };
    },
    refetchInterval: METRICS_POLL_MS,
  });
}
