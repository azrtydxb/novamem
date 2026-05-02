# Phase 2b: Performance & Scalability Review

Service profile: hot-path latency (`/v1/search`, `/v1/remember`, `/v1/recent`) is per-agent-thought, so single-digit-ms regressions matter; cold paths (`/v1/admin/*`, `/v1/me/*`) are interactive (dashboard) and tolerate 100ms+; background jobs (decay, reaper) run every 6h and may scan whole tables.

| Severity | Count |
|---|---|
| Critical | 1 |
| High     | 7 |
| Medium   | 9 |
| Low      | 5 |
| **Total** | **22** |

---

## Critical

### P-C1 — Decay loop is a per-row UPDATE round-trip
**Where:** `packages/server/src/engine/index.ts:264-275`
**Why it matters:** every 6h, `engine.decay()` calls `listColdCandidates(baseDays)` (default LIMIT 1000), then iterates in JS and issues one `UPDATE memory_entries SET cold = true ...` per demotion. With a 1k batch this is ≤1k round-trips per pass; raise the LIMIT to clear backlog and the round-trip count scales linearly. Worse: the lifespan computation is pure SQL-expressible (`(7 × log2(hits+1)) × baseDays/7`) — there is no reason to round-trip at all. At 100k decay candidates this is ~5–10 minutes of wall time vs <1 second for one statement.
**Fix:**
```sql
UPDATE memory_entries e
   SET cold = true, updated_at = now()
  FROM memory_access a
 WHERE e.id = a.entry_id
   AND e.cold = false
   AND EXTRACT(EPOCH FROM (now() - a.last_accessed)) / 86400.0
       > (LOG(2, COALESCE(a.hits,0) + 1) * $1)         -- $1 = baseDays
RETURNING e.id;
```
Count `RETURNING` rows for `demoted`. Drop the `listColdCandidates` LIMIT entirely or run in batches of 10k via `LIMIT … RETURNING`.
**Estimated impact:** ~500–1000× speedup on a populated DB; eliminates the long-running JS loop that holds an idle pool connection for minutes.

---

## High

### P-H1 — Search is N+1: per-result `getEntry` round-trip after fuse
**Where:** `engine/index.ts:207-234`. Loop hits `warm.getEntry(tenantId, f.id)` for each fused result. With `k=10` and 3× over-fetch the pre-fuse pool can be ~30 ids; post-fuse `slice(0, k)` caps the loop at 10 round-trips. Each `getEntry` is a single-row PK lookup (≤1ms hot, but adds up to 10ms+ in the hot path before serialization).
**Fix:** single `WHERE id = ANY($1::text[])` query, reorder client-side:
```ts
const ids = fused.map(f => f.id);
const rows = await this.warm.getEntriesByIds(tenantId, ids, { projectId });
const byId = new Map(rows.map(r => [r.id, r]));
for (const f of fused) {
  const e = byId.get(f.id);
  if (!e) continue;
  …
}
```
Add `getEntriesByIds(tenantId, ids[], {projectId})` to `WarmStore` that runs the same isolation rule. This collapses 10 round-trips to 1 (~10ms → ~1ms in p50, larger in tail because each round-trip pays Pool→Postgres latency). **Combined with the per-result `bumpHits` UPDATE this is currently 2N+1 round-trips** — also batch the bump (see P-H2).
**Estimated impact:** p50 search latency on a co-located DB goes from ~15ms to ~5ms; on cross-AZ DB (1ms RTT) goes from ~25ms to ~6ms.

### P-H2 — `bumpHits` is one UPSERT per result, sequential
**Where:** `engine/index.ts:217` inside the `for (const f of fused)` loop. Each fused id triggers a separate `INSERT … ON CONFLICT DO UPDATE` round-trip. `markCold` for promoted entries adds another. This is the same round-trip-amplification as P-H1.
**Fix:** single batch UPSERT after the loop:
```sql
INSERT INTO memory_access (entry_id, hits, last_accessed)
SELECT id, 1, now() FROM unnest($1::text[]) AS u(id)
ON CONFLICT (entry_id) DO UPDATE
  SET hits = memory_access.hits + 1, last_accessed = now();
```
**Estimated impact:** another ~10× reduction in writes per search; combined with P-H1 makes /v1/search a true two-query path.

### P-H3 — Metrics endpoint runs 4 unbounded `SELECT COUNT(*)` per dashboard poll
**Where:** `main.ts:67-87` (gauge sources), called from `MetricsCollector.snapshot()` every 5s by the dashboard via `/v1/admin/metrics` and `/v1/me/metrics`. The two `COUNT(*) FROM memory_entries WHERE cold = …` queries become **sequential scans** on Postgres at scale: with 10M rows and an unindexed `cold` filter, each scan is multiple seconds (already noted that `idx_entries_cold` exists, but it's a low-cardinality boolean — Postgres usually picks a seq scan anyway because the planner judges half the table is "matching"). With even one open dashboard tab, this is a permanent ~1–10 QPS load of seq-scan-style queries.
**Fix:**
1. Add a composite index `idx_entries_tenant_cold (tenant_id, cold)` for the per-tenant variant (selective on `tenant_id`, helps the planner keep an index scan).
2. For the global gauge, switch to `pg_class.reltuples` or maintain an in-process counter that's seeded from a one-shot count at startup and bumped/decremented in `insertEntry`/`markCold`/`deleteTenant`. Snapshot reads no DB.
3. Cache gauge values for ~5s (the poll interval) so two simultaneous dashboards still hit DB once.
**Estimated impact:** at 10M rows, /v1/admin/metrics goes from O(seconds) to O(microseconds); removes a steady-state CPU drain on Postgres.

### P-H4 — `decay_runs` `ORDER BY id DESC LIMIT 1` hits per `/v1/stats`
**Where:** `warm-store/index.ts:949` runs every `engine.stats(tenantId)` call. `decay_runs` PK is `serial`, so the sort is index-scannable, but each call adds a round-trip the engine doesn't need to chain. Combined with `stats()`'s `GROUP BY namespace, cold` query, every `/v1/stats` is **2 sequential queries** instead of 1. `stats()` itself is a `GROUP BY (namespace, cold)` filtered by `tenant_id` — needs `idx_entries_tenant_namespace_cold` for big tenants. Without it, scales with the tenant's row count.
**Fix:** cache `lastDecayAt` in the `MetricsCollector` (already tracked there) and read from there; or `Promise.all` the two queries.
**Estimated impact:** halves `/v1/stats` latency; bigger win is removing pgPool back-pressure under burst.

### P-H5 — `cold_orphans` reaper sorts by `last_attempt_at` with no index
**Where:** `engine/index.ts:441-453`. Query `SELECT … FROM cold_orphans WHERE attempts < $1 ORDER BY last_attempt_at ASC NULLS FIRST LIMIT $2`. Schema has `idx_orphans_attempts(attempts)` but **no index on `last_attempt_at`**. With a low-cardinality `attempts < 10` filter and a sort on an unindexed column, Postgres reads the whole queue and sorts in memory each pass. Fine while orphans are rare (typically zero), but a bad day producing 100k orphans makes the reaper scan-and-sort 100k rows every cycle.
**Fix:** drop the single-column index, replace with a composite that supports the exact access pattern:
```sql
CREATE INDEX idx_orphans_pending ON cold_orphans (attempts, last_attempt_at NULLS FIRST)
  WHERE attempts < 10;
```
(Partial index is justified — once `attempts >= maxAttempts` the row is dead weight.)
**Estimated impact:** O(N log N) sort → O(log N) index lookup; on a 100k-orphan queue, ~50ms → ~1ms per reaper iteration.

### P-H6 — `linkVectorNeighbors` issues one Cypher query per neighbor
**Where:** `engine/index.ts:147-156`. `graphLinkFanout = 3` ⇒ 3 sequential `addEdge` round-trips on every `remember()`, plus 3 `addRelation` UPSERTs to Postgres. This is the dominant latency in the write hot path: `/v1/remember` p50 today is ~(embed time + insert + cold upsert + 3 graph + 3 warm relation) ≈ 30–60ms, of which ~half is the relation fanout. FalkorDB tolerates batched MERGE in one query.
**Fix:** single Cypher with `UNWIND $rows AS row MERGE (a:Memory {id: row.from, …}) MERGE (b:Memory {id: row.to, …}) MERGE (a)-[r:RELATES {kind: row.rel}]->(b) SET r.strength = row.strength`. For the warm side, batch UPSERT via `unnest($1::text[], $2::text[], …)`.
**Estimated impact:** /v1/remember p50 down ~30–40%; bigger relative win on cross-AZ deployments.

### P-H7 — No `pg.Pool` `max` configured → connection exhaustion under load
**Where:** `warm-store/index.ts:42` — `new Pool({ connectionString: cfg.url })`. Default max is 10 connections per pool. Hot paths chain queries (search: ftsSearch + getEntry×N + bumpHits×N; remember: insertEntry + insertFts + insertAccess + cold + relations×fanout; stats: 2). Under burst, pool starvation causes per-request queueing latency that masquerades as "Postgres slow." Worse, the pool is shared with the dashboard's metrics poll, the reaper, the decay loop, and tests.
**Fix:** make pool size config-driven (`NOVAMEM_PG_POOL_MAX`, default 20–30), set `idleTimeoutMillis: 30_000`, and add `connectionTimeoutMillis: 5_000` so failures fail fast instead of hanging. Also consider `statement_timeout` to bound runaway queries.
**Estimated impact:** prevents a foreseeable production surprise; the symptom under load is not slow queries but a bimodal latency distribution where some requests wait minutes for a connection.

---

## Medium

### P-M1 — `engine.recent` SQL builder has a duplicate `$2` placeholder bug
**Where:** `engine/index.ts:303-316`. `params` is built `[namespace, k]`, then `tenantId`/`projectId` is *appended* and referenced via `$${params.length}`. Then `since` is appended at `$4` (or `$3` if no project), and the trailing `LIMIT $2` still points to `k` — that part is correct. **However**, the *previous* placeholder logic still has `params.push(tenantId)` at index 3 and `params.push(args.since)` at index 4 — totally fine numerically, but the code reads `LIMIT $2` literally, which works only because `params[1]` is `k`. Phase 1 already flagged this as fragile; from a *perf* lens the issue is that there's no `idx_entries_namespace_created_at` to support `WHERE namespace=… ORDER BY created_at DESC`. A tenant with 1M entries in one namespace will table-scan + sort.
**Fix:** add composite index `(tenant_id, namespace, created_at DESC)` (and a parallel `(project_id, namespace, created_at DESC)` for project queries) to make `/v1/recent` an index-only scan. Ten‐fold speedup on hot tenants.
**Estimated impact:** /v1/recent goes from O(rows-in-namespace) to O(k).

### P-M2 — Missing composite `(tenant_id, project_id, namespace)` index for the canonical scope filter
**Where:** schema has separate indexes on `tenant_id`, `project_id`, `namespace`. The `ftsSearch` join filters by all three plus `tsv @@ plainto_tsquery`. The GIN tsv index dominates, but for non-FTS paths (`/v1/recent`, `stats`, the metrics gauges) the planner can only use one b-tree index, so it picks `tenant_id` (worst-case all rows for the tenant, then post-filter). A composite `(tenant_id, project_id, namespace)` is canonical for this app.
**Fix:** add it. Postgres already supports `WHERE project_id IS NULL` against this; consider also a partial `WHERE project_id IS NULL` variant if tenant-wide queries dominate.
**Estimated impact:** keyword-less recent/stats queries go from O(per-tenant rows) to O(per-namespace rows) — typical 10–100×.

### P-M3 — `MetricsCollector.perTenant` Map grows without eviction
**Where:** `admin/metrics.ts:139, 159-166`. Every `recordRemember`/`recordQuery`/`recordForget` path calls `slot(tenantId)` which lazy-creates an entry. Tenants that are deleted via `/v1/admin/tenants/:id` leave their slot in memory forever; per-tenant ring buffers also retain timestamps for 60s but the *slot itself* never goes away.
**Fix:** in `engine.deleteTenant` (or a `MetricsCollector.dropTenant(id)` method called from there), `this.perTenant.delete(tenantId)`. Also add a periodic sweep that deletes slots whose rings are empty AND whose counters haven't moved in N minutes.
**Estimated impact:** unbounded memory growth in long-lived deployments with high tenant churn (think: ephemeral test tenants in CI). With 100k provisioned-and-deleted tenants the Map alone is ~50MB.

### P-M4 — `tenant_tokens.last_used_at` writes on every authenticated request
**Where:** `warm-store/index.ts:251`. Every API call in tenant mode runs `UPDATE tenant_tokens SET last_used_at = now() WHERE token_hash = $1`. Pros: no separate query; cons: at sustained 100 RPS this is 100 writes/sec to a hot row family, plus WAL pressure. Postgres HOT-update keeps it cheap (no indexed columns change), but the txn + WAL still cost.
**Fix:** debounce to once per N seconds. Either:
- Coalesce in-process: `Map<tokenHash, lastFlush>`, only write when `now - lastFlush > 60_000`.
- Or `UPDATE … WHERE last_used_at < now() - interval '1 minute'` so the UPDATE no-ops most of the time.
**Estimated impact:** at 1000 RPS, dropping ~58/60ths of these writes saves measurable WAL bandwidth and contention; tail latency improvement under burst.

### P-M5 — `sessions.last_seen_at` updated on every dashboard request — same hotspot
**Where:** `warm-store/index.ts:540-547`. Same pattern as P-M4 but on session bearer resolution. Dashboard polls `/v1/admin/metrics` every 5s, hammering this row.
**Fix:** same debounce technique. Sessions only need `last_seen_at` granularity in seconds, not subseconds.
**Estimated impact:** a logged-in admin with the dashboard open = 1 write/5s per session. Fine for one user; with N concurrent admins this is N writes/5s on a very hot row.

### P-M6 — `ensureCollection`'s `getCollections()` is a list-all-collections call
**Where:** `cold-store.ts:50-65`. The first time a (tenant, namespace, project) triple is touched, the cold store calls `client.getCollections()` — a Qdrant API that lists *all* collections cluster-wide. With many tenants × namespaces × projects, this list is large; on cold start it's also called once per never-seen-before triple in the first request. The `seenCollections` Set hides this on the second hit, but the warm-up cost is real.
**Fix:** memoize a single `getCollections()` Promise across all callers (so concurrent first-hits collapse to one round-trip), and refresh lazily — or use `client.getCollection(name)` and 404-as-create-needed instead of listing the world.
**Estimated impact:** cold start on a cluster with 1000 collections: per-namespace warmup time reduced from ~50–200ms to ~1–5ms.

### P-M7 — `health` and `/v1/admin/tenants` cold-store ping is a `getCollections()` listing
**Where:** `cold-store.ts:168-174`. `/health` runs every K8s liveness/readiness probe (default ~10s) and lists *all* collections to prove Qdrant is reachable. With 1000 collections this is a non-trivial response payload (and Qdrant has to enumerate them on the server). For a liveness probe, a `client.versionInfo()` or any cheap GET would suffice.
**Fix:** swap to a Qdrant root health endpoint. Failing that, cache the result for 5s (probes don't need real-time freshness).
**Estimated impact:** at 6 probes/min × 1000 collections, removes a steady ~100ms drain.

### P-M8 — Bcrypt cost factor 10 + no rate-limit on `/v1/auth/login` = login-DoS
**Where:** `auth.ts` (cost 10 ⇒ ~50ms CPU per login), `http.ts:240-246` (rate-limit allowList includes only `/health`). Bcrypt cost 10 is correct for password storage; the operational concern is that a brute-force attacker can pin a CPU core at 50ms per attempted login — at the 600 req/min global rate-limit budget, that's 10 logins/sec × 50ms = 500ms of cpu/sec, **half a core just for bogus logins**. With multiple IPs or compromised proxies, easily exhausts capacity.
**Fix:**
- Per-username throttle: `MAX 5 failed logins / 15 minutes` (already in your security report). Track in-memory `Map<username, {failedAt: number[]}>`.
- Tighter route-specific limit: `app.register(rateLimit, …, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } })` for `/v1/auth/login` only.
**Estimated impact:** removes a trivial DoS vector; minimal cost to legitimate users (they don't fail-and-retry 10× per minute).

### P-M9 — Idempotent DDL acquires `AccessExclusiveLock` even for no-op `ALTER TABLE`
**Where:** `warm-store/index.ts:46-191` runs ~30 DDL statements on every server boot. `ALTER TABLE … ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are no-ops on populated DBs but **still acquire `AccessExclusive` (ALTER) or `Share` (CREATE INDEX)** for the duration of the no-op — typically ms but blocks running queries during a K8s rolling deploy with multiple pods racing to boot. With 3 replicas booting in parallel each takes the lock serially, multiplying startup time.
**Fix:** wrap in a single `pg_advisory_xact_lock(<schema-version-hash>)` so only one pod at a time runs DDL; the others wait, see "everything already exists," and proceed. Or move to drizzle-kit migrations and run them once via an init container, never on app boot. Phase 1 also flagged DDL ordering bug M4/A9 — these go together.
**Estimated impact:** rolling-deploy ready-time goes from ~N × DDL-time to ~1 × DDL-time. Also eliminates a class of "two pods race to ALTER" warnings.

---

## Low

### P-L1 — `cold.search`'s 3× over-fetch (`limit: k * 3`) is not configurable
**Where:** `engine/index.ts:175, 179`. `k * 3` is hardcoded for both keyword and vector. The 3× is a recall-vs-latency knob — bigger pre-fuse pool = better fused recall, more CPU on Qdrant scoring. No reason to hardwire it.
**Fix:** expose as `EngineConfig.fusionOverFetch` (default 3). Operators with poor recall can dial up to 5; operators with tight latency budgets dial to 2. Bonus: also gate `cold.search` payload — `with_payload: true` returns the full payload, but the engine only uses `entryId` from it and re-fetches everything else from Postgres. Switch to `with_payload: ["entryId"]` to cut bytes.
**Estimated impact:** small; mostly future-proofing. The `with_payload` projection is real bandwidth savings — payloads include user content if anything's persisted there.

### P-L2 — Cypher `${depth}`/`${limit}` interpolation in `graph.neighbors`
**Where:** `graph-store.ts:93-96`. Two values are string-interpolated rather than parameterized. FalkorDB supports parameter binding for these in current versions; the inconsistency means every distinct (depth, limit) pair compiles fresh. Negligible but pollutes query cache.
**Fix:** `MATCH (a)-[r:RELATES*1..$depth]-(b) … LIMIT $limit` and pass via `params`. (Verify FalkorDB version supports parameterized variable-length paths — older versions don't.)

### P-L3 — admin-ui bundle ~167KB gzipped; recharts is the heavy hitter
**Where:** `admin-ui/vite.config.ts` does no manual chunking. `MetricsPage.tsx` is the only user of recharts, but the whole bundle ships on every page load.
**Fix:** lazy-route the metrics page so recharts is loaded only when needed:
```tsx
const MetricsPage = lazy(() => import("./pages/MetricsPage"));
…
<Suspense fallback={<SkeletonMetrics />}>
  <MetricsPage />
</Suspense>
```
And in vite.config.ts:
```js
output: {
  manualChunks: { recharts: ['recharts'] },
}
```
**Estimated impact:** initial bundle cuts to ~80–100KB gzipped; first-paint improves on slow networks. Login page (the hot path for unauth users) is currently bloated with chart code it'll never use.

### P-L4 — MetricsPage chart re-renders the entire `<AreaChart>` on every poll
**Where:** `admin-ui/src/pages/MetricsPage.tsx:95-100, 199-249`. Every 5s the `history` array gets a new tail point and React reconciles the whole chart. Recharts diffs internally, but the `<defs>` element and gradients re-render too. Minor at 30 points; if `HISTORY_POINTS` ever grows it scales O(N).
**Fix:** memoize chart props via `useMemo`, lift `<defs>` out of the data-driven render, or cap history at a hard size (already done at 30 — fine for now).

### P-L5 — `CORS: { origin: true }` reflects every Origin → no preflight cache benefit
**Where:** `http.ts:205`. `origin: true` means Access-Control-Allow-Origin echoes the request's Origin, so the browser can't cache a preflight across origins. Since the dashboard is same-origin and `mcp/sse` is the only cross-origin candidate, an explicit allow-list would let preflights cache for the configured `maxAge`.
**Fix:** `cors({ origin: ['http://localhost:5173', '<allowed-prod-origins>'], maxAge: 86400 })`.
**Estimated impact:** removes one OPTIONS round-trip per cross-origin request after warmup. Security report has the bigger reason to fix this.

---

## Quick reference — biggest wins, smallest patches

1. **Decay UPDATE → single SQL statement (P-C1)** — 1 file, ~20 lines.
2. **Search `getEntry` + `bumpHits` batching (P-H1, P-H2)** — 1 method add to `WarmStore`, 1 loop refactor in engine.
3. **In-process gauges + composite `(tenant_id, cold)` index (P-H3, P-M2)** — schema migration + ~30 lines in MetricsCollector.
4. **`pg.Pool` max size (P-H7)** — 1 line + env var.
5. **Composite `(tenant_id, namespace, created_at DESC)` (P-M1)** — schema migration; transforms `/v1/recent`.
6. **Lazy-load MetricsPage (P-L3)** — 5-line change to App router; ~half the dashboard bundle goes away on every other route.

The decay loop and the search hot-path are the two highest-leverage paths. Past that, Postgres index hygiene (P-M2, P-M1, P-H5) and the metrics gauge query rewrite (P-H3) are the structural fixes that prevent the service from entering a death spiral once `memory_entries` crosses ~1M rows.
