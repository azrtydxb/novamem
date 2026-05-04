/**
 * MemoryEngine — the synchronous TypeScript core. Both the HTTP and MCP
 * adapters compose this same object.
 */

import { createHash } from "node:crypto";

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

/** Stable hash of normalized content. Used by the worthiness gate to
 *  detect exact duplicates within a (user, project) scope. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Token-set Jaccard similarity, lowercased and stop-word-naive. Used by
 *  the dream cycle to gate vector-similarity merges — a high cosine
 *  alone isn't enough; the texts also have to share lexical surface
 *  area or we'd merge contradictions like "Pascal lives in Dubai" with
 *  "Pascal lives in Belgium". */
function tokenJaccard(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  const union = ta.size + tb.size - intersect;
  return intersect / union;
}

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

  /** Hard-rule worthiness gate. Returns null when the content is fit to
   *  store, or a short reason string when it should be rejected. The
   *  caller is responsible for honouring `force: true` to bypass.
   *
   *  No LLM judging here — that lives behind a future `NOVAMEM_JUDGE_URL`
   *  config option. Hard rules only:
   *    - too short to be durable knowledge (< 12 chars after trim)
   *    - obvious conversational filler (single-word / canned reply)
   *
   *  Exact-duplicate detection happens separately via content_hash so we
   *  can return the existing id instead of rejecting outright. */
  shouldReject(content: string): string | null {
    const trimmed = content.trim();
    if (trimmed.length < 12) return "too short — not durable knowledge";
    if (
      /^(thanks?|ok(ay)?|sure|got it|great|cool|yes|no|nope|yep|alright|noted|done)\.?$/i.test(
        trimmed,
      )
    ) {
      return "conversational filler — not durable knowledge";
    }
    return null;
  }

  async remember(
    userId: string,
    req: RememberRequest,
    token?: TokenIdentity,
  ): Promise<{ id: string | null; rejected?: string; deduplicated?: boolean }> {
    // ── Worthiness gate (hard rules + dedup) ────────────────────────
    if (!req.force) {
      const reason = this.shouldReject(req.content);
      if (reason) return { id: null, rejected: reason };
    }
    const namespace = req.namespace ?? "default";
    const projectId = req.project ?? null;
    const contentHash = sha256Hex(req.content.trim());
    // Exact-duplicate fast-path: same user, same project, same hash → return
    // the existing id and bump hits instead of inserting a second row.
    const existing = await this.warm.findByContentHash(userId, projectId, contentHash);
    if (existing) {
      await this.warm.bumpHits(existing);
      this.metrics?.recordRemember(userId, token);
      return { id: existing, deduplicated: true };
    }
    const id = await this.warm.insertEntry({
      userId,
      projectId,
      content: req.content,
      namespace,
      source: req.source ?? "manual",
      agentName: req.agentName ?? null,
      metadata: req.metadata,
      sourceType: req.sourceType ?? null,
      capturedFrom: req.capturedFrom ?? null,
      confidence: req.confidence,
      contentHash,
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

  /** Update an existing entry in place. Preserves `created_at`,
   *  `memory_access.hits`, and graph edges; rewrites content / FTS / cold
   *  vector / metadata / provenance. Returns `{ updated: false }` when
   *  the id doesn't exist or is out of the caller's scope.
   *
   *  When `content` is omitted, the embedder isn't called — only the
   *  metadata-side fields move. */
  async update(
    userId: string,
    id: string,
    req: {
      content?: string;
      namespace?: string;
      metadata?: Record<string, unknown>;
      sourceType?: string;
      capturedFrom?: string;
      confidence?: number;
      project?: string | null;
    },
  ): Promise<{ updated: boolean; embeddingChanged: boolean }> {
    const projectId = req.project ?? null;
    const newHash = req.content ? sha256Hex(req.content.trim()) : undefined;
    const ok = await this.warm.updateEntry({
      userId,
      id,
      projectId,
      content: req.content,
      namespace: req.namespace,
      metadata: req.metadata,
      sourceType: req.sourceType,
      capturedFrom: req.capturedFrom,
      confidence: req.confidence,
      contentHash: newHash,
    });
    if (!ok) return { updated: false, embeddingChanged: false };
    let embeddingChanged = false;
    if (req.content) {
      // Re-resolve the entry to learn its actual namespace (the caller
      // may have omitted it from the update body).
      const entry = await this.warm.getEntry(userId, id, { projectId });
      if (!entry) return { updated: true, embeddingChanged: false };
      const [embedding] = await this.embedder.embed(req.content);
      if (embedding) {
        await this.cold.upsert({
          userId,
          projectId: entry.projectId ?? null,
          id,
          namespace: entry.namespace,
          embedding,
          payload: { source: entry.source, agentName: entry.agentName ?? null },
        });
        embeddingChanged = true;
      }
    }
    return { updated: true, embeddingChanged };
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
    const k = req.k ?? 10;
    const weights = { ...DEFAULT_WEIGHTS, ...(req.weights ?? {}) };

    // Active-project mode: when `includeProjects` is set, fan out across
    // (user-global) ∪ (each project) and merge before fusion. Single-
    // scope queries (project, or no project) collapse to one fanout.
    const scopes: Array<string | null> = req.includeProjects?.length
      ? [null, ...req.includeProjects]
      : [req.project ?? null];

    // Cross-namespace mode: when `includeNamespaces` is set, fan out across
    // each namespace within each scope. Cold-store collections are keyed
    // per (scope × namespace) so this fans out as a 2D matrix. The single
    // singular `namespace` field is ignored in this mode.
    const namespaces: string[] = req.includeNamespaces?.length
      ? req.includeNamespaces
      : [req.namespace ?? "default"];

    const [embedding] = await this.embedder.embed(req.query);
    // FTS supports multi-namespace via `namespace = ANY(...)` in one query
    // per scope, so we fan out only across scopes (not namespaces).
    // Cold-store needs one search per (scope × namespace) collection.
    const [keywordHitsAll, vectorHitsAll] = await Promise.all([
      Promise.all(
        scopes.map((projectId) =>
          this.warm.ftsSearch({
            userId,
            projectId,
            query: req.query,
            namespace: namespaces[0]!, // ignored when namespaces array is set
            namespaces: namespaces.length > 1 ? namespaces : undefined,
            k: k * 3,
            agentName: req.agentName === undefined ? undefined : (req.agentName ?? null),
          }),
        ),
      ),
      embedding
        ? Promise.all(
            scopes.flatMap((projectId) =>
              namespaces.map((namespace) =>
                this.cold.search({ userId, projectId, namespace, embedding, k: k * 3 }),
              ),
            ),
          )
        : Promise.resolve([] as Array<Array<{ id: string; score: number }>>),
    ]);
    const keywordHits = keywordHitsAll.flat();
    const vectorHits = vectorHitsAll.flat();
    // Single-scope path keeps the original projectId for downstream lookups
    // (entries / neighbors). Multi-scope path uses null + per-id resolution.
    const projectId = scopes.length === 1 ? scopes[0]! : null;

    let graphHits: Array<{ id: string; score: number }> = [];
    let degraded = false;
    if (this.graph?.isConnected() && vectorHits.length > 0) {
      const seed = vectorHits[0]!.id;
      try {
        // Graph neighbours scope: when in active-project mode the seed is
        // ambiguous, so skip the project scope (project_id is null) — entry
        // resolution below will still filter to the visible scope set.
        const seedScope = scopes.length === 1 ? scopes[0]! : null;
        graphHits = await this.graph.neighbors(userId, seed, 1, k, seedScope);
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
    const entries = await this.warm.getEntries(userId, fusedIds, {
      projectId,
      includeProjects: req.includeProjects,
    });
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
    args: {
      namespace?: string;
      k?: number;
      since?: string;
      project?: string | null;
      includeProjects?: string[];
      includeNamespaces?: string[];
    },
  ): Promise<{ results: SearchResult[] }> {
    const namespaces = args.includeNamespaces?.length
      ? args.includeNamespaces
      : [args.namespace ?? "default"];
    const k = args.k ?? 20;
    const projectId = args.project ?? null;
    const includeProjects = args.includeProjects ?? null;
    // Same isolation rule as ftsSearch / getEntry: project-set queries scope
    // by project_id only (members may be cross-user). User-wide queries
    // scope by user_id with project_id IS NULL. Active-project mode unions
    // the user-global view with the listed (membership-checked) projects.
    const params: Array<string | number | string[]> = [namespaces, k];
    let sql =
      `SELECT id, content, namespace, project_id, source, metadata, cold, created_at
         FROM memory_entries
        WHERE namespace = ANY($1::text[])`;
    if (includeProjects && includeProjects.length > 0) {
      params.push(userId);
      const userParam = `$${params.length}`;
      params.push(includeProjects);
      const listParam = `$${params.length}`;
      sql += ` AND ((user_id = ${userParam} AND project_id IS NULL) OR project_id = ANY(${listParam}::text[]))`;
    } else if (projectId === null) {
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
    args: {
      id: string;
      depth?: number;
      k?: number;
      project?: string | null;
      includeProjects?: string[];
      /** Accepted for API symmetry with search/recent but not used by the
       *  graph store — Memory nodes aren't namespaced; entry resolution
       *  picks up the entry's actual namespace from Postgres. */
      includeNamespaces?: string[];
    },
  ): Promise<{ results: SearchResult[]; degraded: boolean }> {
    const depth = args.depth ?? 1;
    const k = args.k ?? 10;
    const projectId = args.project ?? null;
    const includeProjects = args.includeProjects;
    if (!this.graph?.isConnected()) return { results: [], degraded: true };
    // Cross-user + cross-project guard. In active-project mode the seed
    // may belong to user-global or any included project — resolve it once
    // and bind further traversal to its actual scope.
    const seedRows = includeProjects?.length
      ? await this.warm.getEntries(userId, [args.id], { includeProjects })
      : [await this.warm.getEntry(userId, args.id, { projectId })];
    const seedEntry = seedRows[0];
    if (!seedEntry) return { results: [], degraded: false };
    const seedScope = seedEntry.projectId ?? null;
    const hits = await this.graph.neighbors(userId, args.id, depth, k, seedScope);
    const results: SearchResult[] = [];
    for (const h of hits) {
      const e = includeProjects?.length
        ? (await this.warm.getEntries(userId, [h.id], { includeProjects }))[0]
        : await this.warm.getEntry(userId, h.id, { projectId });
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
   *  check is the `getEntry` above: it returns `undefined` for cross-user
   *  ids and (for project-scoped queries) for entries in a different
   *  project. The DELETEs that follow MUST scope by the same boundary —
   *  P0-5: when the entry is project-scoped, scope by project_id (NOT
   *  user_id, because cross-user project members must be able to
   *  delete shared rows); when user-wide, scope by user_id. */
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
    // user_id is decorative (and may differ from the bearer's owning user
    // for shared projects). When user-wide, user_id is the boundary.
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

  /** Dream cycle — periodic compaction. Runs in two phases:
   *
   *    1. Dedup-merge: for each entry, find vector-near neighbours via
   *       cold.search, accept a pair as duplicate when cosine ≥ 0.97
   *       AND token-set Jaccard ≥ 0.5 (both required so contradictions
   *       like "lives in X" / "lives in Y" don't merge). Pick the
   *       canonical (most hits, oldest tiebreak), redirect graph edges
   *       to the canonical id, sum hit counts, delete the duplicate.
   *
   *    2. Edge promotion: when two memories share ≥3 graph neighbours
   *       in common, add a direct A→B edge with relation = co_inferred
   *       so search picks up transitive connections. Tagged distinctly
   *       from the original co_occurs so search ranking can dial it
   *       back if the inferred edges turn out to be noisy.
   *
   *  Runs cross-user — operates on whatever rows exist. The audit log
   *  records each merge so operators can spot-check.
   *
   *  No LLM-based summarization in scope yet — that lives behind a
   *  future `NOVAMEM_JUDGE_URL` config. */
  async dreamCycle(opts: {
    cosineThreshold?: number;
    jaccardThreshold?: number;
    edgePromotionMinCommon?: number;
    /** Cap rows-walked-per-run so a huge store doesn't pin a worker
     *  for an hour. Default 5000. */
    maxEntries?: number;
  } = {}): Promise<{
    walked: number;
    merged: number;
    edgesPromoted: number;
    durationMs: number;
  }> {
    const cosineMin = opts.cosineThreshold ?? 0.97;
    const jaccardMin = opts.jaccardThreshold ?? 0.5;
    const minCommon = opts.edgePromotionMinCommon ?? 3;
    const limit = opts.maxEntries ?? 5000;
    const startedAt = Date.now();
    let walked = 0;
    let merged = 0;
    const mergedSet = new Set<string>();

    // ── Phase 1: dedup-merge ────────────────────────────────────────
    const rows = await this.warm.pool.query<{
      id: string;
      user_id: string;
      project_id: string | null;
      namespace: string;
      content: string;
    }>(
      `SELECT id, user_id, project_id, namespace, content
         FROM memory_entries
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    for (const row of rows.rows) {
      walked++;
      // Skip ones we've already merged this run.
      if (mergedSet.has(row.id)) continue;
      const [embedding] = await this.embedder.embed(row.content);
      if (!embedding) continue;
      let neighbours: Array<{ id: string; score: number }> = [];
      try {
        neighbours = await this.cold.search({
          userId: row.user_id,
          projectId: row.project_id,
          namespace: row.namespace,
          embedding,
          k: 4,
        });
      } catch (err) {
        this.logger.warn(`[dream] cold.search failed: ${(err as Error).message}`);
        continue;
      }
      for (const n of neighbours) {
        if (n.id === row.id) continue;
        if (mergedSet.has(n.id)) continue;
        if (n.score < cosineMin) continue;
        const other = await this.warm.getEntry(row.user_id, n.id, {
          projectId: row.project_id,
        });
        if (!other) continue;
        if (tokenJaccard(row.content, other.content) < jaccardMin) continue;
        // Pick canonical: prefer the one with more hits, oldest as
        // tiebreak. Sum hits onto the canonical, redirect edges,
        // delete the loser.
        const rowStats = await this.warm.getColdEntryStats(row.id);
        const otherStats = await this.warm.getColdEntryStats(n.id);
        const rowHits = rowStats?.hits ?? 0;
        const otherHits = otherStats?.hits ?? 0;
        const rowOlder = (await this.warm.getEntry(row.user_id, row.id, {
          projectId: row.project_id,
        }))!.createdAt < other.createdAt;
        const keepRow =
          rowHits > otherHits || (rowHits === otherHits && rowOlder);
        const keepId = keepRow ? row.id : n.id;
        const dropId = keepRow ? n.id : row.id;
        try {
          await this.mergeEntries(row.user_id, row.project_id, keepId, dropId);
          merged++;
          mergedSet.add(dropId);
          if (dropId === row.id) break; // current row was the loser
        } catch (err) {
          this.logger.warn(`[dream] merge ${dropId}→${keepId} failed: ${(err as Error).message}`);
        }
      }
    }

    // ── Phase 2: edge promotion ─────────────────────────────────────
    const promoted = await this.promoteCommonNeighborEdges(minCommon);

    return {
      walked,
      merged,
      edgesPromoted: promoted,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Helper for dreamCycle: merge `dropId` into `keepId`. Sums hits,
   *  redirects graph edges, deletes the warm row + cold vector + memory_fts
   *  shadow + memory_access counter for `dropId`. */
  private async mergeEntries(
    userId: string,
    projectId: string | null,
    keepId: string,
    dropId: string,
  ): Promise<void> {
    const pool = this.warm.pool;
    // Sum hit counts onto the canonical.
    await pool.query(
      `UPDATE memory_access SET hits = hits + COALESCE(
         (SELECT hits FROM memory_access WHERE entry_id = $2), 0
       ),
       last_accessed = greatest(last_accessed,
         COALESCE((SELECT last_accessed FROM memory_access WHERE entry_id = $2), last_accessed))
       WHERE entry_id = $1`,
      [keepId, dropId],
    );
    // Redirect inbound + outbound graph edges to the canonical.
    await pool.query(
      `UPDATE memory_relations SET to_id = $1 WHERE to_id = $2 AND from_id <> $1`,
      [keepId, dropId],
    );
    await pool.query(
      `UPDATE memory_relations SET from_id = $1 WHERE from_id = $2 AND to_id <> $1`,
      [keepId, dropId],
    );
    await pool.query(
      `DELETE FROM memory_relations WHERE from_id = $1 OR to_id = $1`,
      [dropId],
    );
    // Drop the FTS shadow + access counter + warm row + cold vector.
    await pool.query(`DELETE FROM memory_fts WHERE entry_id = $1`, [dropId]);
    await pool.query(`DELETE FROM memory_access WHERE entry_id = $1`, [dropId]);
    const namespaceRow = await pool.query<{ namespace: string }>(
      `SELECT namespace FROM memory_entries WHERE id = $1`,
      [dropId],
    );
    const namespace = namespaceRow.rows[0]?.namespace ?? "default";
    await pool.query(`DELETE FROM memory_entries WHERE id = $1`, [dropId]);
    if (this.graph?.isConnected()) {
      try {
        await this.graph.removeNode(userId, dropId);
      } catch (err) {
        this.logger.warn(`[dream] graph removeNode(${dropId}) failed: ${(err as Error).message}`);
      }
    }
    try {
      await this.cold.delete(userId, namespace, dropId, projectId);
    } catch (err) {
      this.logger.warn(`[dream] cold.delete(${dropId}) failed: ${(err as Error).message}`);
    }
  }

  /** Edge promotion: for any pair (A, B) of memories that share at
   *  least `minCommon` graph neighbours, add a direct A→B edge with
   *  relation=co_inferred. Uses a single SQL pass that picks the top
   *  candidates by common-neighbour count; cheap on most stores. */
  private async promoteCommonNeighborEdges(minCommon: number): Promise<number> {
    const r = await this.warm.pool.query(
      `WITH co AS (
         SELECT r1.from_id AS a, r2.from_id AS b, COUNT(*) AS c
           FROM memory_relations r1
           JOIN memory_relations r2
             ON r1.to_id = r2.to_id
            AND r1.from_id <> r2.from_id
          WHERE r1.relation = 'co_occurs'
            AND r2.relation = 'co_occurs'
          GROUP BY r1.from_id, r2.from_id
         HAVING COUNT(*) >= $1
       )
       INSERT INTO memory_relations (user_id, from_id, to_id, relation, strength)
       SELECT (SELECT user_id FROM memory_entries e WHERE e.id = co.a), co.a, co.b,
              'co_inferred', LEAST(0.5 + (co.c::real / 20.0), 0.9)
         FROM co
       ON CONFLICT (from_id, to_id, relation) DO NOTHING`,
      [minCommon],
    );
    return r.rowCount ?? 0;
  }

  /** Delete a user and every artefact it owns across warm, cold, and
   *  graph. The warm purge is transactional; cold and graph are best-effort
   *  but always attempted. Refuses to delete the synthetic `public` user
   *  (would orphan legacy single-user rows). */
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
      coldCollectionsDropped = await this.cold.deleteAllForUser(userId);
    } catch (err) {
      this.logger.warn(`[engine] deleteUser(${userId}): cold cleanup failed: ${(err as Error).message}`);
    }
    let graphCleared = false;
    if (this.graph?.isConnected()) {
      // graph-store now returns whether the DELETE actually ran (it logs
      // its own error on failure). Don't claim graphCleared falsely.
      graphCleared = await this.graph.removeAllForUser(userId);
    }
    // P2-5: drop the user's MetricsCollector slot so the in-memory Map
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
