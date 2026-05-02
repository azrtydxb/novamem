/**
 * MemoryEngine — the synchronous TypeScript core. Both the HTTP and MCP
 * adapters compose this same object.
 */

import { ColdStore } from "../cold-store.js";
import { GraphStore } from "../graph-store.js";
import { WarmStore } from "../warm-store/index.js";
import type { Embedder } from "../embeddings.js";
import type {
  HealthSnapshot,
  MemoryStats,
  RememberRequest,
  SearchRequest,
  SearchResult,
} from "../types.js";
import { DEFAULT_WEIGHTS, effectiveDays, fuse } from "./hybrid-search.js";

export interface EngineConfig {
  warm: WarmStore;
  cold: ColdStore;
  graph: GraphStore | null;
  embedder: Embedder;
  /** Default decay schedule (in days). Used as the base when `effectiveDays`
   *  isn't overridden per call. */
  defaultEffectiveDays?: number;
}

export class MemoryEngine {
  private readonly warm: WarmStore;
  private readonly cold: ColdStore;
  private readonly graph: GraphStore | null;
  private readonly embedder: Embedder;
  private readonly defaultDecayDays: number;
  private readonly startedAt = Date.now();

  constructor(cfg: EngineConfig) {
    this.warm = cfg.warm;
    this.cold = cfg.cold;
    this.graph = cfg.graph;
    this.embedder = cfg.embedder;
    this.defaultDecayDays = cfg.defaultEffectiveDays ?? 7;
  }

  /** Reactive promotion: any cold entry that just got a search hit is
   *  reactivated — its qdrant vector is still in place from before
   *  demotion, so promotion is just flipping the flag. Symmetric to the
   *  decay loop: hits drive entries warm, idle drives them cold. The
   *  consumer of search results sees the post-promotion tier. */
  private async maybePromote(id: string): Promise<boolean> {
    await this.warm.markCold(id, false);
    return true;
  }

  private lastGraphWarn = 0;
  private maybeWarnGraphDown(): void {
    const now = Date.now();
    if (now - this.lastGraphWarn < 5 * 60 * 1000) return;
    this.lastGraphWarn = now;
    console.warn("[engine] graph store unreachable — search degraded to keyword + vector only");
  }

  async remember(req: RememberRequest): Promise<{ id: string }> {
    const namespace = req.namespace ?? "default";
    const id = await this.warm.insertEntry({
      content: req.content,
      namespace,
      source: req.source ?? "manual",
      agentName: req.agentName ?? null,
      metadata: req.metadata,
    });
    const [embedding] = await this.embedder.embed(req.content);
    if (embedding) {
      await this.cold.upsert({
        id,
        namespace,
        embedding,
        payload: { source: req.source ?? "manual", agentName: req.agentName ?? null },
      });
    }
    return { id };
  }

  async search(req: SearchRequest): Promise<{ results: SearchResult[]; degraded: boolean }> {
    const namespace = req.namespace ?? "default";
    const k = req.k ?? 10;
    const weights = { ...DEFAULT_WEIGHTS, ...(req.weights ?? {}) };

    const [embedding] = await this.embedder.embed(req.query);
    const [keywordHits, vectorHits] = await Promise.all([
      this.warm.ftsSearch({
        query: req.query,
        namespace,
        k: k * 3,
        agentName: req.agentName === undefined ? undefined : (req.agentName ?? null),
      }),
      embedding ? this.cold.search({ namespace, embedding, k: k * 3 }) : Promise.resolve([]),
    ]);

    let graphHits: Array<{ id: string; score: number }> = [];
    let degraded = false;
    if (this.graph?.isConnected() && vectorHits.length > 0) {
      const seed = vectorHits[0]!.id;
      try {
        graphHits = await this.graph.neighbors(seed, 1, k);
      } catch (err) {
        degraded = true;
        console.warn("[engine] graph neighbours failed:", (err as Error).message);
      }
    } else if (!this.graph || !this.graph.isConnected()) {
      degraded = true;
      // Rate-limited: only complain once every 5 minutes.
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

    const results: SearchResult[] = [];
    for (const f of fused) {
      const e = await this.warm.getEntry(f.id);
      if (!e) continue;
      await this.warm.bumpHits(f.id);

      // Cold→warm promotion: if a cold entry just got hit and its new
      // lifespan now exceeds its idle age, it's earned its way back to
      // warm. The qdrant vector stayed put through demotion, so promotion
      // is just flipping the flag. Reactive — no separate pass needed.
      let tier: "warm" | "cold" = e.cold ? "cold" : "warm";
      if (e.cold) {
        const promoted = await this.maybePromote(f.id);
        if (promoted) tier = "warm";
      }

      results.push({
        id: f.id,
        score: f.score,
        content: e.content,
        tier,
        namespace: e.namespace,
        source: e.source,
        metadata: (e.metadata ?? {}) as Record<string, unknown>,
        signals: f.signals,
      });
    }
    return { results, degraded };
  }

  async decay(opts: { effectiveDaysOverride?: number } = {}): Promise<{ demoted: number }> {
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
    const candidates = await this.warm.listColdCandidates(baseDays);
    let demoted = 0;
    for (const c of candidates.rows) {
      // Lifespan is in 7-day units by default; scale to whatever base the
      // caller asked for so the override actually shifts the curve.
      const lifespan = (effectiveDays(c.hits) / 7) * baseDays;
      const idle = Number(c.idle_days);
      if (idle > lifespan) {
        await this.warm.markCold(c.id, true);
        demoted++;
      }
    }
    if (runId !== undefined) {
      await this.warm.pool.query(
        `UPDATE decay_runs SET finished_at = now(), demoted = $1 WHERE id = $2`,
        [demoted, runId],
      );
    }
    return { demoted };
  }

  /** Recent entries in a namespace, ordered newest first. Optional `since`
   *  ISO-8601 lower bound for time-windowed queries ("since yesterday"). */
  async recent(args: { namespace?: string; k?: number; since?: string }): Promise<{ results: SearchResult[] }> {
    const namespace = args.namespace ?? "default";
    const k = args.k ?? 20;
    const sinceClause = args.since ? "AND created_at >= $3" : "";
    const params: any[] = [namespace, k];
    if (args.since) params.push(args.since);
    const rows = await this.warm.pool.query(
      `SELECT id, content, namespace, source, metadata, cold, created_at
         FROM memory_entries
        WHERE namespace = $1 ${sinceClause}
        ORDER BY created_at DESC
        LIMIT $2`,
      params,
    );
    const results = rows.rows.map((r: any) => ({
      id: r.id,
      score: 1.0,
      content: r.content,
      tier: r.cold ? ("cold" as const) : ("warm" as const),
      namespace: r.namespace,
      source: r.source,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      signals: { keyword: 0, vector: 0, graph: 0 },
    }));
    return { results };
  }

  /** Graph-neighbour traversal from a seed memory id. Depth defaults to 1. */
  async neighbors(args: { id: string; depth?: number; k?: number }): Promise<{ results: SearchResult[]; degraded: boolean }> {
    const depth = args.depth ?? 1;
    const k = args.k ?? 10;
    if (!this.graph?.isConnected()) return { results: [], degraded: true };
    const hits = await this.graph.neighbors(args.id, depth, k);
    const results: SearchResult[] = [];
    for (const h of hits) {
      const e = await this.warm.getEntry(h.id);
      if (!e) continue;
      results.push({
        id: h.id,
        score: h.score,
        content: e.content,
        tier: e.cold ? "cold" : "warm",
        namespace: e.namespace,
        source: e.source,
        metadata: (e.metadata ?? {}) as Record<string, unknown>,
        signals: { keyword: 0, vector: 0, graph: h.score },
      });
    }
    return { results, degraded: false };
  }

  /** Explicit deletion. Removes warm row, FTS shadow, cold vector, graph
   *  edges. Idempotent — missing ids are silently ignored. */
  async forget(id: string): Promise<{ deleted: boolean; coldDeleteOk: boolean }> {
    const e = await this.warm.getEntry(id);
    if (!e) return { deleted: false, coldDeleteOk: true };
    const pool = this.warm.pool;
    await pool.query("DELETE FROM memory_fts WHERE entry_id = $1", [id]);
    await pool.query("DELETE FROM memory_access WHERE entry_id = $1", [id]);
    await pool.query("DELETE FROM memory_entries WHERE id = $1", [id]);
    let coldDeleteOk = true;
    try {
      await this.cold.delete(e.namespace, id);
    } catch (err) {
      // Warm row is already gone; cold vector is orphaned. Park the id in
      // cold_orphans; the reaper retries on the decay schedule until the
      // qdrant delete succeeds.
      coldDeleteOk = false;
      const message = (err as Error).message;
      console.warn(`[engine] forget(${id}): cold vector survived (${message}); queued for reaper`);
      await pool.query(
        `INSERT INTO cold_orphans (id, namespace, attempts, last_error, last_attempt_at)
         VALUES ($1, $2, 1, $3, now())
         ON CONFLICT (id) DO UPDATE SET
           attempts = cold_orphans.attempts + 1,
           last_error = EXCLUDED.last_error,
           last_attempt_at = now()`,
        [id, e.namespace, message],
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
  }> {
    const maxAttempts = opts.maxAttempts ?? 10;
    const limit = opts.limit ?? 100;
    const rows = await this.warm.pool.query<{ id: string; namespace: string; attempts: number }>(
      `SELECT id, namespace, attempts FROM cold_orphans
        WHERE attempts < $1
        ORDER BY last_attempt_at ASC NULLS FIRST
        LIMIT $2`,
      [maxAttempts, limit],
    );
    let cleared = 0;
    let abandoned = 0;
    for (const r of rows.rows) {
      try {
        await this.cold.delete(r.namespace, r.id);
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
          console.warn(`[engine] cold orphan ${r.id} abandoned after ${newAttempts} attempts: ${message}`);
        }
      }
    }
    const pendingRow = await this.warm.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM cold_orphans WHERE attempts < $1`,
      [maxAttempts],
    );
    return {
      attempted: rows.rows.length,
      cleared,
      abandoned,
      pending: Number(pendingRow.rows[0]?.count ?? 0),
    };
  }

  async stats(): Promise<MemoryStats> {
    const s = await this.warm.stats();
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
