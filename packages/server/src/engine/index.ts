/**
 * MemoryEngine — the synchronous TypeScript core. Both the HTTP and MCP
 * adapters compose this same object.
 */

import { ColdStore } from "../cold-store.js";
import { GraphStore } from "../graph-store.js";
import { WarmStore } from "../warm-store/index.js";
import type { Embedder } from "../embeddings.js";
import type { MetricsCollector, TokenIdentity } from "../admin/metrics.js";
import type {
  HealthSnapshot,
  MemoryStats,
  RememberRequest,
  SearchRequest,
  SearchResult,
} from "../types.js";
import { DEFAULT_WEIGHTS, effectiveDays, fuse } from "./hybrid-search.js";

/** Minimal logger surface — structurally compatible with Pino / Fastify's
 *  logger so callers can plug in either. Defaults to console. */
export interface EngineLogger {
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  info?(msg: string, ...rest: unknown[]): void;
}

export interface EngineConfig {
  warm: WarmStore;
  cold: ColdStore;
  graph: GraphStore | null;
  embedder: Embedder;
  /** Default decay schedule (in days). Used as the base when `effectiveDays`
   *  isn't overridden per call. */
  defaultEffectiveDays?: number;
  /** Optional logger. Defaults to console. */
  logger?: EngineLogger;
  /** When remembering a new entry, link it to this many top vector neighbours
   *  in the graph (skip self). Set to 0 to disable auto-edges. Default 3. */
  graphLinkFanout?: number;
  /** Optional metrics collector. When set, the engine instruments its
   *  hot paths (search/remember/forget/promote/demote/decay/reap). Pure
   *  observation — never affects behaviour. */
  metrics?: MetricsCollector;
}

export class MemoryEngine {
  private readonly warm: WarmStore;
  private readonly cold: ColdStore;
  private readonly graph: GraphStore | null;
  private readonly embedder: Embedder;
  private readonly defaultDecayDays: number;
  private readonly logger: EngineLogger;
  private readonly graphLinkFanout: number;
  private readonly metrics: MetricsCollector | null;
  /** Reactive promotions since the last decay run — flushed to
   *  `decay_runs.promoted` so the column stops being dead weight. */
  private promotedSinceLastDecay = 0;
  private readonly startedAt = Date.now();

  constructor(cfg: EngineConfig) {
    this.warm = cfg.warm;
    this.cold = cfg.cold;
    this.graph = cfg.graph;
    this.embedder = cfg.embedder;
    this.defaultDecayDays = cfg.defaultEffectiveDays ?? 7;
    this.logger = cfg.logger ?? console;
    this.graphLinkFanout = cfg.graphLinkFanout ?? 3;
    this.metrics = cfg.metrics ?? null;
  }

  /** Reactive promotion: a cold entry earns warm status when its accumulated
   *  lifespan (`7 × log₂(hits+1)`) exceeds how long it had been idle before
   *  this hit. Without that check, *any* incidental match would re-promote,
   *  defeating the decay maths. Stats are read pre-bump so a fresh hit
   *  doesn't reset the clock against itself. */
  private async maybePromote(id: string, preBump: { hits: number; idleDays: number } | null): Promise<boolean> {
    if (!preBump) return false;
    // After this call returns the engine bumps hits → +1; lifespan uses the
    // post-bump count so the entry's growth is reflected immediately.
    const lifespan = effectiveDays(preBump.hits + 1);
    if (lifespan <= preBump.idleDays) return false;
    await this.warm.markCold(id, false);
    this.promotedSinceLastDecay++;
    this.metrics?.recordPromotion();
    return true;
  }

  private lastGraphWarn = 0;
  private maybeWarnGraphDown(): void {
    const now = Date.now();
    if (now - this.lastGraphWarn < 5 * 60 * 1000) return;
    this.lastGraphWarn = now;
    this.logger.warn("[engine] graph store unreachable — search degraded to keyword + vector only");
  }

  async remember(
    userId: string,
    req: RememberRequest,
    token?: TokenIdentity,
  ): Promise<{ id: string }> {
    const namespace = req.namespace ?? "default";
    const projectId = req.project ?? null;
    const id = await this.warm.insertEntry({
      userId,
      projectId,
      content: req.content,
      namespace,
      source: req.source ?? "manual",
      agentName: req.agentName ?? null,
      metadata: req.metadata,
    });
    const [embedding] = await this.embedder.embed(req.content);
    if (embedding) {
      await this.cold.upsert({
        userId,
        projectId,
        id,
        namespace,
        embedding,
        payload: { source: req.source ?? "manual", agentName: req.agentName ?? null },
      });
      if (this.graphLinkFanout > 0) {
        await this.linkVectorNeighbors(userId, projectId, id, namespace, embedding);
      }
    }
    this.metrics?.recordRemember(userId, token);
    return { id };
  }

  /** Find the new entry's top semantic neighbours and persist edges in both
   *  the graph store (for traversal) and `memory_relations` (for audit /
   *  fallback if the graph is offline). Self-links are filtered. Errors are
   *  logged and swallowed — failures to enrich shouldn't fail the write. */
  private async linkVectorNeighbors(
    userId: string,
    projectId: string | null,
    id: string,
    namespace: string,
    embedding: number[],
  ): Promise<void> {
    try {
      const hits = await this.cold.search({
        userId,
        projectId,
        namespace,
        embedding,
        k: this.graphLinkFanout + 1,
      });
      const neighbours = hits.filter((h) => h.id !== id).slice(0, this.graphLinkFanout);
      // P1-P3: one batched Cypher round-trip instead of fanout-many.
      if (neighbours.length > 0 && this.graph?.isConnected()) {
        try {
          await this.graph.addEdgesBatch(
            userId,
            id,
            neighbours.map((n) => ({ to: n.id, relation: "co_occurs", strength: n.score })),
            projectId,
          );
        } catch (err) {
          this.logger.warn(`[engine] graph addEdgesBatch(${id}) failed: ${(err as Error).message}`);
        }
      }
      // Warm relations are still per-row (UPSERT semantics differ; volume small).
      for (const n of neighbours) {
        await this.warm.addRelation(userId, id, n.id, "co_occurs", n.score, projectId);
      }
    } catch (err) {
      this.logger.warn(`[engine] linkVectorNeighbors(${id}) failed: ${(err as Error).message}`);
    }
  }

  async search(
    userId: string,
    req: SearchRequest,
    token?: TokenIdentity,
  ): Promise<{ results: SearchResult[]; degraded: boolean }> {
    const namespace = req.namespace ?? "default";
    const k = req.k ?? 10;
    const projectId = req.project ?? null;
    const weights = { ...DEFAULT_WEIGHTS, ...(req.weights ?? {}) };

    const [embedding] = await this.embedder.embed(req.query);
    const [keywordHits, vectorHits] = await Promise.all([
      this.warm.ftsSearch({
        userId,
        projectId,
        query: req.query,
        namespace,
        k: k * 3,
        agentName: req.agentName === undefined ? undefined : (req.agentName ?? null),
      }),
      embedding
        ? this.cold.search({ userId, projectId, namespace, embedding, k: k * 3 })
        : Promise.resolve([]),
    ]);

    let graphHits: Array<{ id: string; score: number }> = [];
    let degraded = false;
    if (this.graph?.isConnected() && vectorHits.length > 0) {
      const seed = vectorHits[0]!.id;
      try {
        graphHits = await this.graph.neighbors(userId, seed, 1, k, projectId);
      } catch (err) {
        degraded = true;
        this.logger.warn("[engine] graph neighbours failed: " + (err as Error).message);
      }
    } else if (!this.graph || !this.graph.isConnected()) {
      degraded = true;
      this.maybeWarnGraphDown();
    }

    const fused = fuse(
      [
        ...keywordHits.map((h) => ({ id: h.id, signals: { keyword: h.score } })),
        ...vectorHits.map((h) => ({ id: h.id, signals: { vector: h.score } })),
        ...graphHits.map((h) => ({ id: h.id, signals: { graph: h.score } })),
      ],
      weights,
    ).slice(0, k);

    // P1-P1: batch the per-result lookups + bump-hits to collapse the
    // search hot path from 2N+1 round-trips to ~3 (one entry lookup, one
    // bump, plus per-cold-entry promotion stats which are typically few).
    const fusedIds = fused.map((f) => f.id);
    const entries = await this.warm.getEntries(userId, fusedIds, { projectId });
    const results: SearchResult[] = [];
    const idsToBump: string[] = [];
    for (let i = 0; i < fused.length; i++) {
      const f = fused[i]!;
      const e = entries[i];
      if (!e) continue;
      idsToBump.push(f.id);

      // Cold→warm promotion: capture stats *before* bumpHits so the
      // pre-hit idle age is what gates promotion — otherwise every hit
      // would trivially clear an idle gap of zero.
      let tier: "warm" | "cold" = e.cold ? "cold" : "warm";
      const preBump = e.cold ? await this.warm.getColdEntryStats(f.id) : null;
      if (e.cold) {
        const promoted = await this.maybePromote(f.id, preBump);
        if (promoted) tier = "warm";
      }

      results.push({
        id: f.id,
        score: f.score,
        content: e.content,
        tier,
        namespace: e.namespace,
        project: e.projectId ?? null,
        source: e.source,
        metadata: (e.metadata ?? {}) as Record<string, unknown>,
        signals: f.signals,
      });
    }
    if (idsToBump.length > 0) await this.warm.bumpHitsMany(idsToBump);
    // Per-tier hit counts: each result may have contributed via more than
    // one signal (e.g. keyword + vector), and we count every contributing
    // signal — that's the operator-visible "this tier carried weight".
    if (this.metrics) {
      let warmHits = 0;
      let coldHits = 0;
      let graphHits = 0;
      for (const f of results) {
        if (f.signals.keyword) warmHits++;
        if (f.signals.vector) coldHits++;
        if (f.signals.graph) graphHits++;
      }
      this.metrics.recordQuery(userId, { warm: warmHits, cold: coldHits, graph: graphHits }, token);
    }
    return { results, degraded };
  }

  async decay(opts: { effectiveDaysOverride?: number } = {}): Promise<{ demoted: number; promoted: number }> {
    // For each warm entry, compare idle age (days since last access) against
    // its effective lifespan: `7 × log₂(hits+1)` — frequently-used memories
    // resist decay because their lifespan grows with use. Override the
    // default 7-day base via `effectiveDaysOverride` for one-shot passes.
    const baseDays = opts.effectiveDaysOverride ?? this.defaultDecayDays;
    const startedAt = new Date();
    const runRow = await this.warm.pool.query<{ id: number }>(
      `INSERT INTO decay_runs (started_at, effective_days) VALUES ($1, $2) RETURNING id`,
      [startedAt, baseDays],
    );
    const runId = runRow.rows[0]?.id;
    // P0-6: bulk SQL replaces a per-row loop. The original JS condition was
    //   lifespan = (effectiveDays(hits) / 7) * baseDays
    //            = (7 * log2(hits + 1) / 7) * baseDays
    //            = log2(hits + 1) * baseDays
    // demote when `idle_days > lifespan`. The whole decay collapses to one
    // round-trip regardless of candidate count (500–1000× faster at scale).
    const r = await this.warm.pool.query<{ id: string }>(
      `WITH candidates AS (
         SELECT e.id,
                COALESCE(a.hits, 0) AS hits,
                EXTRACT(EPOCH FROM (now() - COALESCE(a.last_accessed, e.created_at))) / 86400.0 AS idle_days
           FROM memory_entries e
           LEFT JOIN memory_access a ON a.entry_id = e.id
          WHERE e.cold = false
       ),
       to_demote AS (
         SELECT id FROM candidates
          WHERE idle_days > ($1::double precision) * log(2.0, GREATEST(hits, 0) + 1)
       )
       UPDATE memory_entries
          SET cold = true, updated_at = now()
        WHERE id IN (SELECT id FROM to_demote)
        RETURNING id`,
      [baseDays],
    );
    const demoted = r.rowCount ?? 0;
    if (runId !== undefined) {
      await this.warm.pool.query(
        `UPDATE decay_runs SET finished_at = now(), demoted = $1, promoted = $2 WHERE id = $3`,
        [demoted, this.promotedSinceLastDecay, runId],
      );
    }
    const promoted = this.promotedSinceLastDecay;
    this.promotedSinceLastDecay = 0;
    if (this.metrics) {
      this.metrics.markDecayRun();
      this.metrics.recordDemotion(demoted);
    }
    return { demoted, promoted };
  }

  /** Recent entries in a namespace, ordered newest first. Optional `since`
   *  ISO-8601 lower bound for time-windowed queries ("since yesterday"). */
  async recent(
    userId: string,
    args: { namespace?: string; k?: number; since?: string; project?: string | null },
  ): Promise<{ results: SearchResult[] }> {
    const namespace = args.namespace ?? "default";
    const k = args.k ?? 20;
    const projectId = args.project ?? null;
    // Same isolation rule as ftsSearch / getEntry: project-set queries scope
    // by project_id only (members may be cross-tenant). Tenant-wide queries
    // scope by user_id with project_id IS NULL.
    const params: Array<string | number> = [namespace, k];
    let sql =
      `SELECT id, content, namespace, project_id, source, metadata, cold, created_at
         FROM memory_entries
        WHERE namespace = $1`;
    if (projectId === null) {
      params.push(userId);
      sql += ` AND user_id = $${params.length} AND project_id IS NULL`;
    } else {
      params.push(projectId);
      sql += ` AND project_id = $${params.length}`;
    }
    if (args.since) { params.push(args.since); sql += ` AND created_at >= $${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT $2`;
    const rows = await this.warm.pool.query<{
      id: string;
      content: string;
      namespace: string;
      project_id: string | null;
      source: string;
      metadata: Record<string, unknown> | null;
      cold: boolean;
      created_at: Date;
    }>(sql, params);
    const results = rows.rows.map((r) => ({
      id: r.id,
      score: 1.0,
      content: r.content,
      tier: r.cold ? ("cold" as const) : ("warm" as const),
      namespace: r.namespace,
      project: r.project_id,
      source: r.source,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      signals: { keyword: 0, vector: 0, graph: 0 },
    }));
    return { results };
  }

  /** Graph-neighbour traversal from a seed memory id. Depth defaults to 1. */
  async neighbors(
    userId: string,
    args: { id: string; depth?: number; k?: number; project?: string | null },
  ): Promise<{ results: SearchResult[]; degraded: boolean }> {
    const depth = args.depth ?? 1;
    const k = args.k ?? 10;
    const projectId = args.project ?? null;
    if (!this.graph?.isConnected()) return { results: [], degraded: true };
    // Cross-tenant + cross-project guard: refuse to traverse from a seed the
    // caller can't see in their (tenant, project) scope.
    const seedEntry = await this.warm.getEntry(userId, args.id, { projectId });
    if (!seedEntry) return { results: [], degraded: false };
    const hits = await this.graph.neighbors(userId, args.id, depth, k, projectId);
    const results: SearchResult[] = [];
    for (const h of hits) {
      const e = await this.warm.getEntry(userId, h.id, { projectId });
      if (!e) continue;
      results.push({
        id: h.id,
        score: h.score,
        content: e.content,
        tier: e.cold ? "cold" : "warm",
        namespace: e.namespace,
        project: e.projectId ?? null,
        source: e.source,
        metadata: (e.metadata ?? {}) as Record<string, unknown>,
        signals: { keyword: 0, vector: 0, graph: h.score },
      });
    }
    return { results, degraded: false };
  }

  /** Explicit deletion. Removes warm row, FTS shadow, cold vector, graph
   *  edges. Idempotent — missing ids return `deleted:false`. The access
   *  check is the `getEntry` above: it returns `undefined` for cross-tenant
   *  ids and (for project-scoped queries) for entries in a different
   *  project. The DELETEs that follow MUST scope by the same boundary —
   *  P0-5: when the entry is project-scoped, scope by project_id (NOT
   *  user_id, because cross-tenant project members must be able to
   *  delete shared rows); when tenant-wide, scope by user_id. */
  async forget(
    userId: string,
    id: string,
    opts: { project?: string | null; token?: TokenIdentity } = {},
  ): Promise<{ deleted: boolean; coldDeleteOk: boolean }> {
    const e = await this.warm.getEntry(userId, id, { projectId: opts.project ?? null });
    if (!e) return { deleted: false, coldDeleteOk: true };
    this.metrics?.recordForget(userId, opts.token);
    const pool = this.warm.pool;
    const isProject = e.projectId !== null;
    // Scope clause for the by-id DELETEs. When the row is project-scoped,
    // project_id = entry's project_id is the correct access boundary;
    // user_id is decorative (and may differ from the bearer's tenant
    // for shared projects). When tenant-wide, user_id is the boundary.
    const scopeClause = isProject ? "project_id = $2" : "user_id = $2";
    const scopeValue = isProject ? e.projectId! : userId;
    await pool.query(
      `DELETE FROM memory_fts WHERE entry_id = $1 AND ${scopeClause}`,
      [id, scopeValue],
    );
    await pool.query("DELETE FROM memory_access WHERE entry_id = $1", [id]);
    await pool.query(
      `DELETE FROM memory_relations
        WHERE (from_id = $1 OR to_id = $1) AND ${scopeClause}`,
      [id, scopeValue],
    );
    await pool.query(
      `DELETE FROM memory_entries WHERE id = $1 AND ${scopeClause}`,
      [id, scopeValue],
    );
    if (this.graph?.isConnected()) {
      try {
        await this.graph.removeNode(userId, id);
      } catch (err) {
        this.logger.warn(`[engine] forget(${id}): graph removeNode failed: ${(err as Error).message}`);
      }
    }
    let coldDeleteOk = true;
    try {
      await this.cold.delete(userId, e.namespace, id, e.projectId ?? null);
    } catch (err) {
      // Warm row is already gone; cold vector is orphaned. Park the id in
      // cold_orphans; the reaper retries on the decay schedule until the
      // qdrant delete succeeds. The orphan row carries user_id so the
      // reaper knows which collection to delete from.
      coldDeleteOk = false;
      const message = (err as Error).message;
      this.logger.warn(`[engine] forget(${id}): cold vector survived (${message}); queued for reaper`);
      await pool.query(
        `INSERT INTO cold_orphans (id, user_id, namespace, project_id, attempts, last_error, last_attempt_at)
         VALUES ($1, $2, $3, $4, 1, $5, now())
         ON CONFLICT (id) DO UPDATE SET
           attempts = cold_orphans.attempts + 1,
           last_error = EXCLUDED.last_error,
           last_attempt_at = now()`,
        [id, userId, e.namespace, e.projectId ?? null, message],
      );
    }
    return { deleted: true, coldDeleteOk };
  }

  /** Reaper pass: retries each queued orphan's cold-store delete and
   *  removes it from the queue on success. Called from the decay loop and
   *  exposed at /v1/reap-orphans for manual triggers. Returns counts so
   *  operators can tell how much drift was cleaned up. */
  async reapOrphans(opts: { maxAttempts?: number; limit?: number } = {}): Promise<{
    attempted: number;
    cleared: number;
    abandoned: number;
    pending: number;
    total: number;
  }> {
    const maxAttempts = opts.maxAttempts ?? 10;
    const limit = opts.limit ?? 100;
    const rows = await this.warm.pool.query<{
      id: string;
      user_id: string;
      namespace: string;
      project_id: string | null;
      attempts: number;
    }>(
      `SELECT id, user_id, namespace, project_id, attempts FROM cold_orphans
        WHERE attempts < $1
        ORDER BY last_attempt_at ASC NULLS FIRST
        LIMIT $2`,
      [maxAttempts, limit],
    );
    let cleared = 0;
    let abandoned = 0;
    for (const r of rows.rows) {
      try {
        await this.cold.delete(r.user_id, r.namespace, r.id, r.project_id);
        await this.warm.pool.query(`DELETE FROM cold_orphans WHERE id = $1`, [r.id]);
        cleared++;
      } catch (err) {
        const message = (err as Error).message;
        const newAttempts = r.attempts + 1;
        await this.warm.pool.query(
          `UPDATE cold_orphans SET attempts = $1, last_error = $2, last_attempt_at = now() WHERE id = $3`,
          [newAttempts, message, r.id],
        );
        if (newAttempts >= maxAttempts) {
          abandoned++;
          this.logger.warn(`[engine] cold orphan ${r.id} abandoned after ${newAttempts} attempts: ${message}`);
        }
      }
    }
    // Two counters so operators see both retry-eligible work AND the
    // permanently-stuck tail: `pending` excludes abandoned, `total` is the
    // full queue depth incl. abandoned rows still on disk.
    const counts = await this.warm.pool.query<{ pending: string; total: string }>(
      `SELECT COUNT(*) FILTER (WHERE attempts < $1)::text AS pending,
              COUNT(*)::text AS total
         FROM cold_orphans`,
      [maxAttempts],
    );
    const row = counts.rows[0];
    if (cleared > 0) this.metrics?.recordOrphansReaped(cleared);
    return {
      attempted: rows.rows.length,
      cleared,
      abandoned,
      pending: Number(row?.pending ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  /** Delete a tenant and every artefact it owns across warm, cold, and
   *  graph. The warm purge is transactional; cold and graph are best-effort
   *  but always attempted. Refuses to delete the synthetic `public` tenant
   *  (would orphan legacy single-tenant rows). */
  async deleteUser(userId: string): Promise<{
    deleted: boolean;
    entriesRemoved: number;
    coldCollectionsDropped: string[];
    graphCleared: boolean;
  }> {
    const warm = await this.warm.deleteUserAndMemory(userId);
    if (!warm.deleted) {
      return { deleted: false, entriesRemoved: 0, coldCollectionsDropped: [], graphCleared: false };
    }
    let coldCollectionsDropped: string[] = [];
    try {
      coldCollectionsDropped = await this.cold.deleteAllForTenant(userId);
    } catch (err) {
      this.logger.warn(`[engine] deleteUser(${userId}): cold cleanup failed: ${(err as Error).message}`);
    }
    let graphCleared = false;
    if (this.graph?.isConnected()) {
      // graph-store now returns whether the DELETE actually ran (it logs
      // its own error on failure). Don't claim graphCleared falsely.
      graphCleared = await this.graph.removeAllForTenant(userId);
    }
    // P2-5: drop the tenant's MetricsCollector slot so the in-memory Map
    // doesn't accumulate dead entries.
    this.metrics?.forgetUser(userId);
    return {
      deleted: true,
      entriesRemoved: warm.entriesRemoved,
      coldCollectionsDropped,
      graphCleared,
    };
  }

  /** Delete a project + every memory artefact owned by it (warm rows,
   *  cold collections, graph nodes, project-scoped tokens, members).
   *  Does NOT enforce permissions — the HTTP layer must verify the
   *  caller is the project owner before invoking this. */
  async deleteProject(projectId: string): Promise<{
    deleted: boolean;
    entriesRemoved: number;
    coldCollectionsDropped: string[];
    graphCleared: boolean;
  }> {
    const warm = await this.warm.deleteProject(projectId);
    if (!warm.deleted) {
      return { deleted: false, entriesRemoved: 0, coldCollectionsDropped: [], graphCleared: false };
    }
    let coldCollectionsDropped: string[] = [];
    try {
      coldCollectionsDropped = await this.cold.deleteAllForProject(projectId);
    } catch (err) {
      this.logger.warn(`[engine] deleteProject(${projectId}): cold cleanup failed: ${(err as Error).message}`);
    }
    let graphCleared = false;
    if (this.graph?.isConnected()) {
      graphCleared = await this.graph.removeAllForProject(projectId);
    }
    return {
      deleted: true,
      entriesRemoved: warm.entriesRemoved,
      coldCollectionsDropped,
      graphCleared,
    };
  }

  async stats(userId: string): Promise<MemoryStats> {
    const s = await this.warm.stats(userId);
    const byNamespace: Record<string, { warm: number; cold: number }> = {};
    let totalWarm = 0;
    let totalCold = 0;
    for (const r of s.rows) {
      const slot = (byNamespace[r.namespace] ??= { warm: 0, cold: 0 });
      const n = Number(r.count);
      if (r.cold) {
        slot.cold += n;
        totalCold += n;
      } else {
        slot.warm += n;
        totalWarm += n;
      }
    }
    return {
      byNamespace,
      totalWarm,
      totalCold,
      lastDecayAt: s.lastDecayAt ? s.lastDecayAt.toISOString() : null,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  async health(): Promise<HealthSnapshot> {
    const [warmOk, coldOk] = await Promise.all([this.warm.ping(), this.cold.ping()]);
    const graphState: HealthSnapshot["deps"]["graph"] = !this.graph
      ? "disabled"
      : this.graph.isConnected()
        ? "ok"
        : "unreachable";
    return {
      ok: warmOk && coldOk,
      deps: {
        warm: warmOk ? "ok" : "unreachable",
        cold: coldOk ? "ok" : "unreachable",
        graph: graphState,
      },
    };
  }
}

export { effectiveDays, fuse, DEFAULT_WEIGHTS } from "./hybrid-search.js";
