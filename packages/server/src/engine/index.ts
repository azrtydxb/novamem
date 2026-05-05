/**
 * MemoryEngine — the synchronous TypeScript core. Both the HTTP and MCP
 * adapters compose this same object.
 */

import { createHash } from "node:crypto";

import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";

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
import {
  DEFAULT_WEIGHTS,
  effectiveDays,
  EFFECTIVE_LIFESPAN_SQL,
  fuse,
} from "./hybrid-search.js";

/** Stable hash of normalized content. Used by the worthiness gate to
 *  detect exact duplicates within a (user, project) scope. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Lowercased English-stopword shortlist for `tokenJaccard`. Kept small
 *  and conservative — the goal is to drop the high-frequency glue words
 *  ("the", "in", "is", …) that otherwise let near-contradictions clear
 *  the dream cycle's 0.5 threshold. Identifiers and content words stay. */
const JACCARD_STOPWORDS = new Set([
  "a", "an", "the",
  "i", "you", "he", "she", "it", "we", "they",
  "me", "my", "your", "his", "her", "our", "their",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "have", "has", "had",
  "to", "of", "in", "on", "at", "by", "for", "from", "with", "as",
  "and", "or", "but", "if", "so", "than", "that", "this",
  "not", "no", "nor",
]);

/** Token-set Jaccard similarity, lowercased and stop-word-filtered. Used
 *  by the dream cycle to gate vector-similarity merges — a high cosine
 *  alone isn't enough; the texts also have to share content-word
 *  surface area or we'd merge contradictions like "Pascal lives in
 *  Dubai" with "Pascal lives in Belgium" (which share only the glue
 *  words `i`/`in`/`live` — exactly what the stopword filter strips). */
export function tokenJaccard(a: string, b: string): number {
  const tokenize = (s: string) => {
    const out = new Set<string>();
    for (const t of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (JACCARD_STOPWORDS.has(t)) continue;
      out.add(t);
    }
    return out;
  };
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  const union = ta.size + tb.size - intersect;
  return intersect / union;
}

/** Minimal logger surface — structurally compatible with Pino /
 *  Fastify's logger. Object-first: `(obj, msg)` is the idiomatic Pino
 *  call shape; the bare-string overload is kept for the small handful
 *  of callers that don't have structured fields to attach.
 *  Defaults to console when none is supplied. */
export interface EngineLogger {
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  info?(obj: object, msg?: string): void;
  info?(msg: string): void;
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
  private logger: EngineLogger;
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
    // Default-to-console fallback. The cast is safe: console.warn /
    // .error / .info are structurally compatible with the
    // (obj|string, msg?) overloads — the second positional arg is just
    // appended as an extra arg by console, which is fine for fallback.
    this.logger = cfg.logger ?? (console as unknown as EngineLogger);
    this.graphLinkFanout = cfg.graphLinkFanout ?? 3;
    this.metrics = cfg.metrics ?? null;
  }

  /** Replace the engine's logger after construction. main.ts uses this
   *  to swap the boot-time console fallback for `app.log.child({ component: "engine" })`
   *  once the Fastify server (and thus the Pino logger) exists. */
  setLogger(logger: EngineLogger): void {
    this.logger = logger;
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

  /** Resolve the implicit namespace fanout for search/recent when the
   *  caller specified neither `namespace` nor `includeNamespaces`. Walks
   *  every scope (user-global + each active project) and unions the
   *  distinct namespaces with entries *visible* in that scope — note
   *  that in project scope a member sees other members' namespaces too
   *  (project is the isolation boundary). Falls back to `["default"]`
   *  when nothing is visible yet — the embedder / FTS still need a
   *  target name. Deduplicated; order is not stable. */
  private async resolveDefaultNamespaces(
    userId: string,
    scopes: Array<string | null>,
  ): Promise<string[]> {
    // includeProjects mode (multi-scope) and single-scope (one entry,
    // possibly null for user-global) collapse to the same fanout per
    // listNamespaces call.
    const found = new Set<string>();
    if (scopes.length > 1) {
      // Active-project mode: pass the project-id list through.
      const includeProjects = scopes.filter((s): s is string => s !== null);
      const ns = await this.warm.listNamespaces(userId, { includeProjects });
      for (const n of ns) found.add(n);
    } else {
      const single = scopes[0] ?? null;
      const ns = await this.warm.listNamespaces(userId, { projectId: single });
      for (const n of ns) found.add(n);
    }
    if (found.size === 0) return ["default"];
    return [...found];
  }

  private lastGraphWarn = 0;
  private maybeWarnGraphDown(): void {
    const now = Date.now();
    if (now - this.lastGraphWarn < 5 * 60 * 1000) return;
    this.lastGraphWarn = now;
    this.logger.warn("graph store unreachable — search degraded to keyword + vector only");
  }

  /** Hard-rule worthiness gate. Returns null when the content is fit to
   *  store, or a short reason string when it should be rejected. The
   *  caller is responsible for honouring `force: true` to bypass.
   *
   *  Two rules:
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
      // One batched Cypher round-trip instead of fanout-many.
      if (neighbours.length > 0 && this.graph?.isConnected()) {
        try {
          await this.graph.addEdgesBatch(
            userId,
            id,
            neighbours.map((n) => ({ to: n.id, relation: "co_occurs", strength: n.score })),
            projectId,
          );
        } catch (err) {
          this.logger.warn(
            { entryId: id, err: (err as Error).message },
            "graph addEdgesBatch failed",
          );
        }
      }
      // Warm relations are still per-row (UPSERT semantics differ; volume small).
      for (const n of neighbours) {
        await this.warm.addRelation(userId, id, n.id, "co_occurs", n.score, projectId);
      }
    } catch (err) {
      this.logger.warn(
        { entryId: id, err: (err as Error).message },
        "linkVectorNeighbors failed",
      );
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
    //
    // When *neither* `namespace` nor `includeNamespaces` is given, fan out
    // across every namespace the caller has entries in (this scope). The
    // old behaviour silently defaulted to "default" — which meant a user
    // who wrote everything to a custom namespace got `[]` from search-
    // without-namespace, which was strictly a bug. Falls back to
    // ["default"] for fresh callers with no entries yet so the embedder /
    // FTS path still has a sensible target.
    const namespaces: string[] = req.includeNamespaces?.length
      ? req.includeNamespaces
      : req.namespace
        ? [req.namespace]
        : await this.resolveDefaultNamespaces(userId, scopes);

    const [embedding] = await this.embedder.embed(req.query);
    // FTS supports multi-namespace via `namespace = ANY(...)` in one query
    // per scope, so we fan out only across scopes (not namespaces).
    // Cold-store needs one search per (scope × namespace) collection.
    //
    // Per-tier `.catch`: a flaky tier should degrade gracefully — search
    // still returns whatever the surviving tiers produced, and `degraded`
    // becomes meaningful for warm/cold (not just graph). Without this,
    // one Postgres or Qdrant blip rejects the whole top-level Promise.all.
    let degraded = false;
    const keywordsPromise = Promise.all(
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
    ).catch((err) => {
      degraded = true;
      this.logger.warn({ err: (err as Error).message }, "keyword tier failed");
      return [] as Array<Array<{ id: string; score: number }>>;
    });
    const vectorsPromise = embedding
      ? Promise.all(
          scopes.flatMap((projectId) =>
            namespaces.map((namespace) =>
              this.cold.search({ userId, projectId, namespace, embedding, k: k * 3 }),
            ),
          ),
        ).catch((err) => {
          degraded = true;
          this.logger.warn({ err: (err as Error).message }, "vector tier failed");
          return [] as Array<Array<{ id: string; score: number }>>;
        })
      : Promise.resolve([] as Array<Array<{ id: string; score: number }>>);
    const [keywordHitsAll, vectorHitsAll] = await Promise.all([keywordsPromise, vectorsPromise]);
    const keywordHits = keywordHitsAll.flat();
    const vectorHits = vectorHitsAll.flat();
    // Single-scope path keeps the original projectId for downstream lookups
    // (entries / neighbors). Multi-scope path uses null + per-id resolution.
    const projectId = scopes.length === 1 ? scopes[0]! : null;

    let graphHits: Array<{ id: string; score: number }> = [];
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
        this.logger.warn({ err: (err as Error).message }, "graph neighbours failed");
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

    // Batch the per-result lookups + bump-hits to collapse the
    // search hot path from 2N+1 round-trips. Cold-entry promotion stats
    // are now batched too (one query for the cold slice instead of one
    // per cold hit) — the per-id loop only computes the gate.
    const fusedIds = fused.map((f) => f.id);
    const entries = await this.warm.getEntries(userId, fusedIds, {
      projectId,
      includeProjects: req.includeProjects,
    });
    // Pre-fetch promotion stats for cold hits in one round-trip.
    const coldHitIds: string[] = [];
    for (let i = 0; i < fused.length; i++) {
      const e = entries[i];
      if (e?.cold) coldHitIds.push(fused[i]!.id);
    }
    const coldStats = coldHitIds.length > 0
      ? await this.warm.getColdEntryStatsMany(coldHitIds)
      : new Map<string, { hits: number; idleDays: number }>();
    const results: SearchResult[] = [];
    const idsToBump: string[] = [];
    const promotionTasks: Array<Promise<{ id: string; promoted: boolean }>> = [];
    for (let i = 0; i < fused.length; i++) {
      const f = fused[i]!;
      const e = entries[i];
      if (!e) continue;
      idsToBump.push(f.id);

      // Cold→warm promotion: capture stats *before* bumpHits so the
      // pre-hit idle age is what gates promotion — otherwise every hit
      // would trivially clear an idle gap of zero. The `markCold(false)`
      // writes still happen one-per-promotion, but the read side is now
      // a single query for the whole cold slice.
      const tier: "warm" | "cold" = e.cold ? "cold" : "warm";
      if (e.cold) {
        const preBump = coldStats.get(f.id) ?? null;
        promotionTasks.push(
          this.maybePromote(f.id, preBump).then((promoted) => ({ id: f.id, promoted })),
        );
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
    // Run all cold→warm flips in parallel and apply tier upgrades to the
    // already-built result rows. Failures are swallowed by maybePromote
    // upstream of here (it returns false on no-op); this layer just
    // surfaces the post-promotion tier on the response.
    if (promotionTasks.length > 0) {
      const promotionOutcomes = await Promise.all(promotionTasks);
      const promotedSet = new Set(
        promotionOutcomes.filter((p) => p.promoted).map((p) => p.id),
      );
      if (promotedSet.size > 0) {
        for (const r of results) if (promotedSet.has(r.id)) r.tier = "warm";
      }
    }
    if (idsToBump.length > 0) await this.warm.bumpHitsMany(idsToBump);
    // Per-tier hit counts: each result may have contributed via more than
    // one signal (e.g. keyword + vector), and we count every contributing
    // signal — that's the operator-visible "this tier carried weight".
    // Naming: warmCount=keyword (FTS), coldCount=vector (cold store),
    // graphCount=graph. The earlier "graphHits" alias shadowed the outer
    // graph-hit array; renamed to break the conflation between "cold tier"
    // and "vector signal".
    if (this.metrics) {
      const signalCounts = { keyword: 0, vector: 0, graph: 0 };
      for (const f of results) {
        if (f.signals?.keyword) signalCounts.keyword++;
        if (f.signals?.vector) signalCounts.vector++;
        if (f.signals?.graph) signalCounts.graph++;
      }
      this.metrics.recordQuery(
        userId,
        { warm: signalCounts.keyword, cold: signalCounts.vector, graph: signalCounts.graph },
        token,
      );
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
    // Bulk SQL replaces a per-row loop. The lifespan formula lives
    // in `EFFECTIVE_LIFESPAN_SQL` next to the JS `effectiveDays` so the
    // two stay in lockstep — substituting `$1::double precision` for the
    // `$BASE` placeholder yields `($1::double precision) * log(2.0,
    // GREATEST(hits, 0) + 1)`, the SQL twin of `effectiveDays(hits)` (with
    // the `7` parameterised so a one-shot pass can override). Demote when
    // `idle_days > lifespan`. One round-trip regardless of candidate count.
    const lifespanSql = EFFECTIVE_LIFESPAN_SQL.replace("$BASE", "$1::double precision");
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
          WHERE idle_days > ${lifespanSql}
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
    // See engine.search for the reasoning behind the no-arg fanout.
    // recent() obeys the same rules: explicit namespace param wins;
    // includeNamespaces wins over that; otherwise resolve the user's
    // populated namespaces in-scope and fall back to ["default"] only
    // when there's nothing yet.
    const projectId = args.project ?? null;
    const includeProjects = args.includeProjects ?? null;
    const recentScopes: Array<string | null> = includeProjects?.length
      ? [null, ...includeProjects]
      : [projectId];
    const namespaces = args.includeNamespaces?.length
      ? args.includeNamespaces
      : args.namespace
        ? [args.namespace]
        : await this.resolveDefaultNamespaces(userId, recentScopes);
    const k = args.k ?? 20;
    // Isolation matches ftsSearch / getEntry / getEntries — see
    // `WarmStore.listRecent` for the breakdown. Engine just maps the
    // request shape onto the store call and converts entry rows into
    // SearchResult shape. `signals` is intentionally omitted: recent()
    // is ordered, not ranked, so "no signal" is the truth — fabricating
    // `{keyword:0, vector:0, graph:0}` would misrepresent it as
    // "scored zero" and is what consumers used to (incorrectly) read.
    const rows = await this.warm.listRecent(userId, {
      namespaces,
      k,
      projectId,
      includeProjects,
      since: args.since ? new Date(args.since) : null,
    });
    const results: SearchResult[] = rows.map((r) => ({
      id: r.id,
      score: 1.0,
      content: r.content,
      tier: r.cold ? ("cold" as const) : ("warm" as const),
      namespace: r.namespace,
      project: r.projectId,
      source: r.source,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
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
    // FalkorDB occasionally surfaces driver-side decode errors for
    // certain depth/topology combinations ("expected List or Null but
    // was Path/Edge"). Treat those the same as an unreachable graph —
    // return empty + degraded:true — so the data-plane (/v1/search)
    // and /v1/neighbors don't 500. The Cypher we emit at depth
    // ≤ 1 and ≥ 2 is structured to avoid these decode hits in the
    // common case; this guard catches the long tail.
    let hits: Array<{ id: string; score: number }>;
    try {
      hits = await this.graph.neighbors(userId, args.id, depth, k, seedScope);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, depth, seedId: args.id },
        "[engine.neighbors] graph driver error — returning degraded",
      );
      return { results: [], degraded: true };
    }
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
        // Only the graph signal is applicable here; keyword / vector
        // are omitted so consumers can tell "not applicable" from
        // "scored zero".
        signals: { graph: h.score },
      });
    }
    return { results, degraded: false };
  }

  /** Explicit deletion. Removes warm row, FTS shadow, cold vector, graph
   *  edges. Idempotent — missing ids return `deleted:false`. The access
   *  check is the `getEntry` above: it returns `undefined` for cross-user
   *  ids and (for project-scoped queries) for entries in a different
   *  project. The DELETEs that follow MUST scope by the same boundary:
   *  when the entry is project-scoped, scope by project_id (NOT
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
        this.logger.warn(
          { entryId: id, err: (err as Error).message },
          "forget: graph removeNode failed",
        );
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
      this.logger.warn(
        { entryId: id, err: message },
        "forget: cold vector survived; queued for reaper",
      );
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
          this.logger.warn(
            { entryId: r.id, attempts: newAttempts, err: message },
            "cold orphan abandoned",
          );
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
   *  Runs cross-user — operates on whatever rows exist. */
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
        this.logger.warn({ err: (err as Error).message }, "dream cold.search failed");
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
        // The dream cycle already knows the dropped row's namespace —
        // it's either `row.namespace` (when `dropId === row.id`) or
        // `other.namespace` (when the neighbour lost). Pass it through
        // so `mergeEntries` doesn't re-SELECT it.
        const dropNamespace = dropId === row.id ? row.namespace : other.namespace;
        try {
          await this.mergeEntries(row.user_id, row.project_id, keepId, dropId, dropNamespace);
          merged++;
          mergedSet.add(dropId);
          if (dropId === row.id) break; // current row was the loser
        } catch (err) {
          this.logger.warn(
            { dropId, keepId, err: (err as Error).message },
            "dream merge failed",
          );
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
    dropNamespace: string,
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
    // Caller already has the namespace — no SELECT needed.
    const namespace = dropNamespace;
    await pool.query(`DELETE FROM memory_entries WHERE id = $1`, [dropId]);
    if (this.graph?.isConnected()) {
      try {
        await this.graph.removeNode(userId, dropId);
      } catch (err) {
        this.logger.warn(
          { dropId, err: (err as Error).message },
          "dream graph removeNode failed",
        );
      }
    }
    try {
      await this.cold.delete(userId, namespace, dropId, projectId);
    } catch (err) {
      this.logger.warn(
        { dropId, err: (err as Error).message },
        "dream cold.delete failed",
      );
    }
  }

  /** Edge promotion: for any pair (A, B) of memories that share at
   *  least `minCommon` graph neighbours, add a direct A→B edge with
   *  relation=co_inferred. Uses a single SQL pass that picks the top
   *  candidates by common-neighbour count; cheap on most stores. */
  private async promoteCommonNeighborEdges(minCommon: number): Promise<number> {
    // Defensive user + project isolation in SQL. The JOIN with
    // `memory_entries` enforces that `r1.from_id` and `r2.from_id` belong
    // to the same user AND the same project (treating NULL projects as
    // equal via COALESCE). The same-user invariant holds in practice for
    // co_occurs edges (cold-store-derived, always same-user), but pinning
    // it here means a future code path that adds cross-user co_occurs
    // edges can't accidentally bleed inferences across users.
    const r = await this.warm.pool.query(
      `WITH co AS (
         SELECT r1.from_id AS a, r2.from_id AS b,
                ea.user_id AS user_id,
                COUNT(*) AS c
           FROM memory_relations r1
           JOIN memory_relations r2
             ON r1.to_id = r2.to_id
            AND r1.from_id <> r2.from_id
           JOIN memory_entries ea ON ea.id = r1.from_id
           JOIN memory_entries eb ON eb.id = r2.from_id
          WHERE r1.relation = 'co_occurs'
            AND r2.relation = 'co_occurs'
            AND ea.user_id = eb.user_id
            AND COALESCE(ea.project_id, '') = COALESCE(eb.project_id, '')
          GROUP BY r1.from_id, r2.from_id, ea.user_id
         HAVING COUNT(*) >= $1
       )
       INSERT INTO memory_relations (user_id, from_id, to_id, relation, strength)
       SELECT co.user_id, co.a, co.b,
              'co_inferred', LEAST(0.5 + (co.c::real / 20.0), 0.9)
         FROM co
       ON CONFLICT (from_id, to_id, relation) DO NOTHING`,
      [minCommon],
    );
    return r.rowCount ?? 0;
  }

  /** Delete a project + every memory artefact owned by it (warm rows,
   *  cold collections, graph nodes, project-scoped tokens, members).
   *  Does NOT enforce permissions — the HTTP layer must verify the
   *  caller is the project owner before invoking this. */
  async deleteProject(
    projectId: string,
    ownerUserId: string,
  ): Promise<{
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
      this.logger.warn(
        { projectId, err: (err as Error).message },
        "deleteProject: cold cleanup failed",
      );
    }
    let graphCleared = false;
    if (this.graph?.isConnected()) {
      // Defence-in-depth: scope the delete to the owner's user namespace
      // (issue #45). Project-scoped graph nodes outside the owner's
      // namespace are left for the dream-cycle / orphan reaper to mop up.
      graphCleared = await this.graph.removeAllForProject({
        userId: ownerUserId,
        projectId,
      });
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
