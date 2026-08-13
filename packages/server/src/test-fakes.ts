/**
 * Lightweight in-memory fakes for the engine's three stores + embedder.
 * Keeps tests fast and deterministic without docker / postgres / qdrant.
 */

import { createHash } from "node:crypto";

import type { ColdStore } from "./cold-store.js";
import type { Embedder } from "./embeddings.js";
import type { WarmStore } from "./warm-store/index.js";
import { MemoryEngine } from "./engine/index.js";
import { MetricsCollector } from "./admin/metrics.js";
import { ulid } from "ulid";

export interface FakeWarmRow {
  id: string;
  userId: string;
  projectId: string | null;
  content: string;
  namespace: string;
  source: string;
  agentName: string | null;
  metadata: Record<string, unknown>;
  cold: boolean;
  /** NULL = no vector yet. Mirrors memory_entries.embedded_at — the
   *  pending-embedding queue lives on the row. */
  embeddedAt: Date | null;
  createdAt: Date;
  hits: number;
  lastAccessed: Date;
  /** Persisted and projected by `getEntry`. The updation path filters
   *  candidates on `sourceType === "fact"`, so these have to round-trip
   *  or that branch silently never runs. */
  sourceType: string | null;
  confidence?: number;
  /** NOT NULL = this chunk owes a fact-extraction pass. Mirrors the
   *  durable queue column; the reconciler tests depend on it surviving
   *  "restarts" (fresh engine over the same store). */
  factsPendingAt: Date | null;
  graphPendingAt: Date | null;
}

export class FakeWarmStore {
  rows = new Map<string, FakeWarmRow>();
  relations: Array<{ userId: string; projectId: string | null; fromId: string; toId: string; relation: string; strength: number }> = [];
  tokens = new Map<
    string,
    {
      userId: string;
      label: string | null;
      scope: "full" | "read_only";
      projectId: string | null;
      expiresAt: Date | null;
      revoked: boolean;
    }
  >();
  users = new Map<string, { id: string; username: string; passwordHash: string; role: string; userId: string | null; createdAt: Date; lastLoginAt: Date | null }>([
    // Synthetic public user — exists for `none`/`bearer` auth modes.
    ["public", { id: "public", username: "public", passwordHash: "unused", role: "user", userId: null, createdAt: new Date(), lastLoginAt: null }],
  ]);
  sessions = new Map<string, { userId: string; expiresAt: Date }>();
  projects = new Map<string, { id: string; name: string; ownerUserId: string; createdAt: Date }>();
  projectMembers = new Map<string, Map<string, { role: string; joinedAt: Date }>>();
  decayRunsInserted = 0;
  decayRunsUpdated = 0;
  coldOrphans = new Map<
    string,
    {
      id: string;
      userId: string;
      namespace: string;
      /** "delete" (vector outlived its warm row) or "backfill" (warm row
       *  exists but its vector never landed). */
      kind: string;
      attempts: number;
      lastError: string;
      lastAttemptAt: Date | null;
    }
  >();
  pool = {
    /** Fake the pool query surface used by engine.recent + engine.forget +
     *  engine.decay. Only the queries the engine actually issues are wired —
     *  anything else throws so tests fail loudly on unexpected SQL. */
    /** `engine.forget()` runs its four DELETEs inside an explicit
     *  transaction, which needs a checked-out client rather than the
     *  pool's convenience `query`. The fake hands back a client that
     *  shares the same handler and treats the transaction control
     *  statements as no-ops — the fake store has no rollback semantics,
     *  and the tests here assert the resulting row state, not atomicity
     *  (that is Postgres's job, exercised by the integration suite). */
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        const verb = sql.trim().toUpperCase();
        if (verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK") return { rows: [] };
        return this.pool.query(sql, params);
      },
      release: () => {},
    }),
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
      // (engine.recent moved off pool.query → WarmStore.listRecent — see
      // FakeWarmStore.listRecent below.)
      // decay run start
      if (sql.startsWith("INSERT INTO decay_runs")) {
        this.decayRunsInserted++;
        return { rows: [{ id: this.decayRunsInserted }] };
      }
      // decay run finish
      if (sql.startsWith("UPDATE decay_runs")) {
        this.decayRunsUpdated++;
        return { rows: [] };
      }
      // Bulk decay SQL: `WITH candidates AS (...) UPDATE memory_entries
      // SET cold = true ...`. Replicate the demote condition in JS.
      if (sql.includes("WITH candidates AS") && sql.includes("UPDATE memory_entries")) {
        const baseDays = Number(params[0]);
        const now = Date.now();
        const rows: Array<{ id: string }> = [];
        for (const r of this.rows.values()) {
          if (r.cold) continue;
          const idleDays = (now - r.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
          const retention = (r.metadata as { retention?: { baseEffectiveDays?: number } } | undefined)?.retention;
          const rowBaseDays = typeof retention?.baseEffectiveDays === "number" ? retention.baseEffectiveDays : baseDays;
          // lifespan = baseDays * log2(hits + 1); demote when idle > lifespan.
          const lifespan = rowBaseDays * Math.log2(Math.max(r.hits, 0) + 1);
          if (idleDays > lifespan) {
            r.cold = true;
            rows.push({ id: r.id });
          }
        }
        // pg returns rowCount in addition to rows; the engine reads rowCount.
        return { rows, rowCount: rows.length } as { rows: { id: string }[]; rowCount: number };
      }
      // forget()
      // The engine's forget builds the scope clause as either
      // `project_id = $2` or `user_id = $2` depending on whether the
      // entry is project-scoped. Inspect the SQL to know which.
      if (sql.startsWith("DELETE FROM memory_fts")) return { rows: [] };
      if (sql.startsWith("DELETE FROM memory_access")) return { rows: [] };
      if (sql.startsWith("DELETE FROM memory_relations")) {
        const id = String(params[0]);
        const scope = String(params[1]);
        const isProject = sql.includes("project_id = $");
        this.relations = this.relations.filter((r) => {
          const isMatch = r.fromId === id || r.toId === id;
          if (!isMatch) return true;
          return isProject ? r.projectId !== scope : r.userId !== scope;
        });
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM memory_entries")) {
        const id = String(params[0]);
        const scope = String(params[1]);
        const isProject = sql.includes("project_id = $");
        const r = this.rows.get(id);
        if (r) {
          if (isProject ? r.projectId === scope : r.userId === scope) {
            this.rows.delete(id);
          }
        }
        return { rows: [] };
      }
      // addRelation()
      if (sql.startsWith("INSERT INTO memory_relations")) {
        const [userId, projectId, fromId, toId, relation, strength] = params as [
          string,
          string | null,
          string,
          string,
          string,
          number,
        ];
        const i = this.relations.findIndex(
          (r) => r.fromId === fromId && r.toId === toId && r.relation === relation,
        );
        if (i >= 0) {
          this.relations[i]!.strength = strength;
          this.relations[i]!.userId = userId;
          this.relations[i]!.projectId = projectId;
        } else {
          this.relations.push({ userId, projectId, fromId, toId, relation, strength });
        }
        return { rows: [] };
      }
      // cold_orphans: insert / update / select / delete + count
      if (sql.includes("INSERT INTO cold_orphans")) {
        const id = String(params[0]);
        const userId = String(params[1]);
        const namespace = String(params[2]);
        // params[3] is project_id (nullable), params[4] is lastError
        const lastError = String(params[4] ?? "");
        const cur = this.coldOrphans.get(id);
        if (cur) {
          cur.attempts += 1;
          cur.lastError = lastError;
          cur.lastAttemptAt = new Date();
        } else {
          this.coldOrphans.set(id, {
            id,
            userId,
            namespace,
            kind: sql.includes("'backfill'") ? "backfill" : "delete",
            attempts: 1,
            lastError,
            lastAttemptAt: new Date(),
          });
        }
        return { rows: [] };
      }
      if (sql.startsWith("SELECT id, user_id, namespace, project_id, attempts, kind FROM cold_orphans")) {
        const maxAttempts = Number(params[0]);
        const limit = Number(params[1]);
        return {
          rows: [...this.coldOrphans.values()]
            .filter((o) => o.attempts < maxAttempts)
            .sort((a, b) => (a.lastAttemptAt?.getTime() ?? 0) - (b.lastAttemptAt?.getTime() ?? 0))
            .slice(0, limit)
            .map((o) => ({
              id: o.id,
              user_id: o.userId,
              namespace: o.namespace,
              project_id: null,
              attempts: o.attempts,
              kind: o.kind ?? "delete",
            })),
        };
      }
      if (sql.startsWith("UPDATE cold_orphans")) {
        const o = this.coldOrphans.get(String(params[2]));
        if (o) {
          o.attempts = Number(params[0]);
          o.lastError = String(params[1] ?? "");
          o.lastAttemptAt = new Date();
        }
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM cold_orphans")) {
        this.coldOrphans.delete(String(params[0]));
        return { rows: [] };
      }
      if (sql.includes("FILTER (WHERE attempts <") && sql.includes("cold_orphans")) {
        const maxAttempts = Number(params[0]);
        const all = [...this.coldOrphans.values()];
        const pending = all.filter((o) => o.attempts < maxAttempts).length;
        return { rows: [{ pending: String(pending), total: String(all.length) }] };
      }
      // getColdEntryStats
      if (sql.includes("FROM memory_access") && sql.includes("WHERE a.entry_id = $1")) {
        const id = String(params[0]);
        const r = this.rows.get(id);
        if (!r) return { rows: [] };
        const idleDays = (Date.now() - r.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
        return { rows: [{ hits: r.hits, idle_days: String(idleDays) }] };
      }
      // dreamCycle's forward table walk:
      //   SELECT ... FROM memory_entries WHERE id > $2 ORDER BY id ASC LIMIT $1
      if (sql.includes("FROM memory_entries") && sql.includes("ORDER BY id ASC")) {
        const limit = Number(params[0]);
        const cursor = String(params[1] ?? "");
        const rows = [...this.rows.values()]
          .filter((r) => r.id > cursor)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, limit)
          .map((r) => ({
            id: r.id,
            user_id: r.userId,
            project_id: r.projectId,
            namespace: r.namespace,
            content: r.content,
          }));
        return { rows };
      }
      // dreamCycle phase 2 (common-neighbour edge promotion). The fake
      // relation graph is exercised directly by the graph tests; here we
      // return "no promotable pairs", which is a legitimate outcome and
      // keeps the cursor tests focused on phase 1.
      if (sql.includes("WITH co AS") && sql.includes("from_id")) {
        return { rows: [] };
      }
      throw new Error(`fake pool: unhandled SQL — ${sql.slice(0, 60)}`);
    },
  };

  async ping(): Promise<boolean> { return true; }
  async close(): Promise<void> { /* no-op */ }

  async setEmbeddedAt(id: string, at: Date | null): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.embeddedAt = at;
  }

  async isEmbedded(id: string): Promise<boolean> {
    return this.rows.get(id)?.embeddedAt != null;
  }

  async listPendingEmbedding(limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.embeddedAt == null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        projectId: r.projectId,
        content: r.content,
        namespace: r.namespace,
        source: r.source,
        agentName: r.agentName,
      }));
  }

  async setFactsPendingAt(id: string, at: Date | null): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.factsPendingAt = at;
  }

  async setGraphPendingAt(id: string, at: Date | null): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.graphPendingAt = at;
  }

  async listPendingEnrichment(limit: number) {
    const claimed = [...this.rows.values()]
      .filter((r) => r.graphPendingAt != null)
      .sort((a, b) => a.graphPendingAt!.getTime() - b.graphPendingAt!.getTime())
      .slice(0, limit);
    for (const r of claimed) r.graphPendingAt = new Date();
    return claimed
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        projectId: r.projectId,
        content: r.content,
        namespace: r.namespace,
      }));
  }

  async neighborsByRelations(
    userId: string,
    seedId: string,
    depth: number,
    limit: number,
    projectId: string | null,
    _asOfMs: number | null = null,
  ): Promise<Array<{ id: string; score: number }>> {
    const d = Math.max(1, Math.min(3, Math.trunc(depth)));
    const edges = this.relations.filter(
      (r) => r.userId === userId && (r.projectId ?? null) === (projectId ?? null),
    );
    const best = new Map<string, number>();
    const walk = (from: string, score: number, hop: number, path: Set<string>) => {
      if (hop > d) return;
      for (const e of edges) {
        const nxt = e.fromId === from ? e.toId : e.toId === from ? e.fromId : null;
        if (!nxt || path.has(nxt)) continue;
        const sc = score * e.strength;
        if ((best.get(nxt) ?? -1) < sc) best.set(nxt, sc);
        walk(nxt, sc, hop + 1, new Set([...path, nxt]));
      }
    };
    walk(seedId, 1, 1, new Set([seedId]));
    best.delete(seedId);
    return [...best.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  async countPendingEnrichment(): Promise<number> {
    return [...this.rows.values()].filter((r) => r.graphPendingAt != null).length;
  }

  async listPendingFacts(limit: number): Promise<
    Array<{
      id: string;
      userId: string;
      projectId: string | null;
      content: string;
      namespace: string;
      source: string;
      metadata: Record<string, unknown> | null;
    }>
  > {
    // Mirrors the real store's claim-on-read: claimed rows are re-armed
    // to now(), so a concurrent second caller draws different rows.
    const claimed = [...this.rows.values()]
      .filter((r) => r.factsPendingAt != null)
      .sort((a, b) => a.factsPendingAt!.getTime() - b.factsPendingAt!.getTime())
      .slice(0, limit);
    for (const r of claimed) r.factsPendingAt = new Date();
    return claimed
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        projectId: r.projectId,
        content: r.content,
        namespace: r.namespace,
        source: r.source,
        metadata: r.metadata,
      }));
  }

  async countPendingFacts(): Promise<number> {
    return [...this.rows.values()].filter((r) => r.factsPendingAt != null).length;
  }

  async countPendingEmbedding(): Promise<number> {
    return [...this.rows.values()].filter((r) => r.embeddedAt == null).length;
  }

  async insertEntry(args: {
    userId: string;
    projectId?: string | null;
    content: string;
    namespace: string;
    source: string;
    agentName?: string | null;
    metadata?: Record<string, unknown>;
    sourceType?: string | null;
    capturedFrom?: string | null;
    confidence?: number;
    contentHash?: string | null;
    factsPendingAt?: Date | null;
    graphPendingAt?: Date | null;
  }): Promise<string> {
    const id = ulid();
    this.rows.set(id, {
      id,
      userId: args.userId,
      projectId: args.projectId ?? null,
      content: args.content,
      namespace: args.namespace,
      source: args.source,
      agentName: args.agentName ?? null,
      metadata: args.metadata ?? {},
      cold: false,
      embeddedAt: null,
      createdAt: new Date(),
      hits: 0,
      lastAccessed: new Date(),
      // Accepted as an argument but previously discarded, so every stored
      // row read back as sourceType null. The updation path only compares
      // against rows whose sourceType is "fact", so that branch could
      // never run under test.
      sourceType: args.sourceType ?? null,
      confidence: args.confidence,
      factsPendingAt: args.factsPendingAt ?? null,
      graphPendingAt: args.graphPendingAt ?? null,
    });
    if (args.contentHash) {
      this.contentHashIdx.set(
        `${args.userId}:${args.projectId ?? ""}:${args.contentHash}`,
        id,
      );
    }
    return id;
  }


  private canSeeMemory(userId: string, r: MemoryRow): boolean {
    if (r.projectId === null) return r.userId === userId;
    return this.projectMembers.get(r.projectId)?.has(userId) ?? false;
  }

  async listHygieneEntries(userId: string, opts: { k?: number } = {}) {
    return [...this.rows.values()]
      .filter((r) => this.canSeeMemory(userId, r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts.k ?? 400)
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        projectId: r.projectId,
        content: r.content,
        namespace: r.namespace,
        metadata: r.metadata,
      }));
  }

  async ftsSearch(args: {
    userId: string;
    projectId?: string | null;
    query: string;
    namespace: string;
    namespaces?: string[];
    k: number;
    agentName?: string | null;
  }): Promise<Array<{ id: string; score: number }>> {
    const q = args.query.toLowerCase();
    const projectId = args.projectId ?? null;
    const nsSet = new Set(args.namespaces?.length ? args.namespaces : [args.namespace]);
    const matches = [...this.rows.values()]
      .filter((r) => r.userId === args.userId && nsSet.has(r.namespace))
      .filter((r) => r.projectId === projectId)
      .filter((r) => {
        if (args.agentName === undefined) return true;
        return args.agentName === null ? r.agentName === null : r.agentName === args.agentName;
      })
      .map((r) => {
        const tokens = q.split(/\s+/).filter(Boolean);
        const hits = tokens.filter((t) => r.content.toLowerCase().includes(t)).length;
        return hits > 0 ? { id: r.id, score: hits / Math.max(tokens.length, 1) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b!.score - a!.score)
      .slice(0, args.k)
      .map((m) => m!);
    return matches;
  }

  async getEntryScope(id: string) {
    const r = this.rows.get(id);
    if (!r) return undefined;
    return { userId: r.userId, projectId: r.projectId };
  }

  /** In-memory stand-in for the `engine_state` key/value table. */
  engineState = new Map<string, string>();

  async getEngineState(key: string): Promise<string | null> {
    return this.engineState.get(key) ?? null;
  }

  async setEngineState(key: string, value: string): Promise<void> {
    this.engineState.set(key, value);
  }

  /** Queue a warm row whose cold vector never landed, for the reaper to
   *  re-embed. Mirrors the real store's `kind = 'backfill'` orphan row. */
  async recordMissingVector(args: {
    userId: string;
    projectId: string | null;
    entryId: string;
    namespace: string;
  }): Promise<void> {
    this.coldOrphans.set(args.entryId, {
      id: args.entryId,
      userId: args.userId,
      namespace: args.namespace,
      kind: "backfill",
      attempts: 0,
      lastError: "",
      lastAttemptAt: null,
    });
  }

  async clearMissingVector(entryId: string): Promise<void> {
    const o = this.coldOrphans.get(entryId);
    if (o?.kind === "backfill") this.coldOrphans.delete(entryId);
  }

  async getEntry(userId: string, id: string, opts: { projectId?: string | null } = {}) {
    const r = this.rows.get(id);
    if (!r) return undefined;
    if (typeof opts.projectId === "string") {
      // Project IS the isolation unit when set (cross-user members allowed).
      if (r.projectId !== opts.projectId) return undefined;
    } else {
      // User-wide queries: project must be null AND user must match.
      if (r.projectId !== null) return undefined;
      if (r.userId !== userId) return undefined;
    }
    return {
      id: r.id,
      userId: r.userId,
      projectId: r.projectId,
      content: r.content,
      namespace: r.namespace,
      source: r.source,
      agentName: r.agentName,
      metadata: r.metadata,
      cold: r.cold,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
      // The updation path filters candidates on `sourceType === "fact"`,
      // so omitting it here made every candidate look like a raw chunk
      // and silently disabled that whole branch in tests.
      sourceType: r.sourceType ?? null,
      confidence: r.confidence ?? null,
    };
  }

  async bumpHits(id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) {
      r.hits += 1;
      r.lastAccessed = new Date();
    }
  }

  async bumpHitsMany(ids: string[]): Promise<void> {
    for (const id of ids) await this.bumpHits(id);
  }

  async getEntries(userId: string, ids: string[], opts: { projectId?: string | null } = {}) {
    return Promise.all(ids.map((id) => this.getEntry(userId, id, opts)));
  }

  async markCold(id: string, cold: boolean): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.cold = cold;
  }

  async addRelation(
    userId: string,
    fromId: string,
    toId: string,
    relation: string,
    strength: number,
    projectId?: string | null,
  ): Promise<void> {
    const i = this.relations.findIndex(
      (r) => r.fromId === fromId && r.toId === toId && r.relation === relation,
    );
    if (i >= 0) {
      this.relations[i]!.strength = strength;
      this.relations[i]!.userId = userId;
      this.relations[i]!.projectId = projectId ?? null;
    } else {
      this.relations.push({ userId, projectId: projectId ?? null, fromId, toId, relation, strength });
    }
  }

  async getColdEntryStats(id: string): Promise<{ hits: number; idleDays: number } | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    return {
      hits: r.hits,
      idleDays: (Date.now() - r.lastAccessed.getTime()) / (1000 * 60 * 60 * 24),
    };
  }

  async listNamespaces(
    userId: string,
    args: {
      projectId?: string | null;
      includeProjects?: string[] | null;
    } = {},
  ): Promise<string[]> {
    const { projectId = null, includeProjects = null } = args;
    const isActive = !!includeProjects && includeProjects.length > 0;
    const isProject = !isActive && typeof projectId === "string";
    const out = new Set<string>();
    for (const r of this.rows.values()) {
      if (isActive) {
        if (r.projectId === null && r.userId !== userId) continue;
        if (r.projectId !== null && !includeProjects!.includes(r.projectId)) continue;
      } else if (isProject) {
        if (r.projectId !== projectId) continue;
      } else {
        if (r.projectId !== null || r.userId !== userId) continue;
      }
      out.add(r.namespace);
    }
    return [...out];
  }

  async listRecent(
    userId: string,
    args: {
      namespaces: string[];
      k: number;
      projectId?: string | null;
      includeProjects?: string[] | null;
      since?: Date | null;
    },
  ) {
    const { namespaces, k, projectId = null, includeProjects = null, since = null } = args;
    const isActive = !!includeProjects && includeProjects.length > 0;
    const isProject = !isActive && typeof projectId === "string";
    return [...this.rows.values()]
      .filter((r) => namespaces.includes(r.namespace))
      .filter((r) => {
        if (isActive) {
          if (r.projectId === null) return r.userId === userId;
          return includeProjects!.includes(r.projectId);
        }
        if (isProject) return r.projectId === projectId;
        return r.projectId === null && r.userId === userId;
      })
      .filter((r) => !since || r.createdAt >= since)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, k)
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        projectId: r.projectId,
        content: r.content,
        namespace: r.namespace,
        source: r.source,
        agentName: r.agentName,
        metadata: r.metadata,
        cold: r.cold,
        createdAt: r.createdAt,
        updatedAt: r.createdAt,
      }));
  }

  async getColdEntryStatsMany(
    ids: string[],
  ): Promise<Map<string, { hits: number; idleDays: number }>> {
    const out = new Map<string, { hits: number; idleDays: number }>();
    for (const id of ids) {
      const s = await this.getColdEntryStats(id);
      if (s) out.set(id, s);
    }
    return out;
  }

  async stats(userId: string) {
    const rows: Array<{ namespace: string; cold: boolean; count: string }> = [];
    const groups = new Map<string, number>();
    for (const r of this.rows.values()) {
      if (!this.canSeeMemory(userId, r)) continue;
      const key = `${r.namespace}::${r.cold}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    for (const [key, count] of groups) {
      const [namespace, coldStr] = key.split("::");
      rows.push({ namespace: namespace!, cold: coldStr === "true", count: String(count) });
    }
    return { rows, lastDecayAt: null };
  }

  // (Legacy owner-table CRUD removed — users own memory directly.)

  async createUserToken(
    userId: string,
    label?: string,
    opts: {
      scope?: "full" | "read_only";
      projectId?: string | null;
      expiresAt?: Date | null;
    } | null = {},
  ) {
    // Some older tests pass an explicit `null` third arg (the legacy
    // positional projectId) — treat it as "no options".
    const o = opts ?? {};
    // The synthetic "public" user always exists for none/bearer mode.
    if (userId !== "public" && !this.users.has(userId)) return null;
    const token = "nm_test_" + Math.random().toString(36).slice(2, 18);
    this.tokens.set(token, {
      userId,
      label: label ?? null,
      scope: o.scope ?? ("full" as const),
      projectId: o.projectId ?? null,
      expiresAt: o.expiresAt ?? null,
      revoked: false,
    });
    return { token, userId, projectId: o.projectId ?? null, createdAt: new Date() };
  }

  async resolveUserToken(plaintext: string) {
    const t = this.tokens.get(plaintext);
    if (!t || t.revoked) return null;
    // Mirrors the real store: expired resolves exactly like revoked.
    if (t.expiresAt && t.expiresAt.getTime() <= Date.now()) return null;
    return {
      userId: t.userId,
      scope: t.scope,
      projectId: t.projectId,
      tokenHash: this.fakeHash(plaintext),
      label: t.label,
    };
  }

  async listRecentActivity(userId: string, limit = 50) {
    const remembers = [...this.rows.values()]
      .filter((r) => this.canSeeMemory(userId, r))
      .map((r) => ({
        kind: "remember" as const,
        at: r.createdAt.toISOString(),
        text: r.content.slice(0, 160),
        project: r.projectId,
      }));
    const tokens = [...this.tokens.entries()]
      .filter(([, t]) => t.userId === userId && !t.revoked)
      .map(([, t]) => ({
        kind: "token" as const,
        at: new Date().toISOString(),
        text: `Minted token: ${t.label ?? "(no label)"}`,
        project: null,
      }));
    const joins = [...this.projectMembers.entries()]
      .filter(([, members]) => members.has(userId))
      .map(([projectId, members]) => ({
        kind: "project" as const,
        at: members.get(userId)!.joinedAt.toISOString(),
        text: `Joined project: ${projectId}`,
        project: projectId,
      }));
    return [...remembers, ...tokens, ...joins]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  async listTokensCreatedByUser(userId: string) {
    const out: Array<{ tokenHash: string; label: string | null; userId: string }> = [];
    for (const [plain, v] of this.tokens.entries()) {
      if (v.userId === userId && !v.revoked) {
        out.push({ tokenHash: this.fakeHash(plain), label: v.label, userId: v.userId });
      }
    }
    return out;
  }

  async revokeUserToken(plaintext: string): Promise<boolean> {
    const t = this.tokens.get(plaintext);
    if (!t || t.revoked) return false;
    t.revoked = true;
    return true;
  }

  /** Match the real warm-store: sha256 hex. The route-level validation
   *  regex `^[a-f0-9]{64}$` then accepts our fake hashes too. */
  private fakeHash(plaintext: string): string {
    return createHash("sha256").update(plaintext).digest("hex");
  }

  async deleteUserTokenByHash(userId: string, tokenHash: string): Promise<boolean> {
    for (const [plain, v] of [...this.tokens.entries()]) {
      if (v.userId === userId && this.fakeHash(plain) === tokenHash) {
        this.tokens.delete(plain);
        return true;
      }
    }
    return false;
  }

  async rotateUserToken(plaintext: string) {
    const t = this.tokens.get(plaintext);
    if (!t || t.revoked) return null;
    t.revoked = true;
    const newToken = "nm_test_" + Math.random().toString(36).slice(2, 18);
    this.tokens.set(newToken, { userId: t.userId, label: "rotated", projectId: null, revoked: false });
    return { token: newToken, userId: t.userId, createdAt: new Date() };
  }

  async deleteUserAndMemory(id: string) {
    if (id === "public") return { deleted: false, entriesRemoved: 0 };
    if (!this.users.has(id)) return { deleted: false, entriesRemoved: 0 };
    let entriesRemoved = 0;
    for (const [rid, r] of [...this.rows.entries()]) {
      if (r.userId === id) { this.rows.delete(rid); entriesRemoved++; }
    }
    this.relations = this.relations.filter((r) => r.userId !== id);
    for (const [oid, o] of [...this.coldOrphans.entries()]) {
      if (o.userId === id) this.coldOrphans.delete(oid);
    }
    for (const [tk, v] of [...this.tokens.entries()]) {
      if (v.userId === id) this.tokens.delete(tk);
    }
    this.users.delete(id);
    return { deleted: true, entriesRemoved };
  }

  async listUserTokens(userId: string) {
    return [...this.tokens.entries()]
      .filter(([, v]) => v.userId === userId)
      .map(([plain, v]) => ({
        tokenHash: this.fakeHash(plain),
        label: v.label,
        projectId: v.projectId,
        createdAt: new Date(),
        lastUsedAt: null,
        revoked: v.revoked,
      }));
  }

  // ─── Users + sessions ───────────────────────────────────────────────────

  async createUser(args: { username: string; passwordHash: string; role: "admin" | "user"; userId: string | null }) {
    const id = ulid();
    const row = {
      id,
      username: args.username,
      passwordHash: args.passwordHash,
      role: args.role,
      userId: args.userId,
      createdAt: new Date(),
      lastLoginAt: null,
    };
    this.users.set(id, row);
    return { id, username: args.username, role: args.role, userId: args.userId, createdAt: row.createdAt };
  }

  async findUserByUsername(username: string) {
    for (const u of this.users.values()) {
      if (u.username === username) {
        return {
          id: u.id,
          username: u.username,
          passwordHash: u.passwordHash,
          role: u.role,
          userId: u.userId,
        };
      }
    }
    return null;
  }

  /** Strict-email shim — the real warm store keys on Better Auth's
   *  `"user"` table; the fake's `username` field doubles as both name and
   *  email for tests, so we just lower-case compare it. */
  async findUserByExactEmail(email: string) {
    const target = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.username.toLowerCase() === target) {
        return {
          id: u.id,
          username: u.username,
          passwordHash: u.passwordHash,
          role: u.role,
          userId: u.userId,
        };
      }
    }
    return null;
  }

  async findUserById(id: string) {
    const u = this.users.get(id);
    if (!u) return null;
    return { id: u.id, username: u.username, role: u.role, userId: u.userId };
  }

  async listUsers() {
    // Mirrors the real store's admin census shape: email/name derive from
    // the fake's `username`, and the counts are computed live.
    return [...this.users.values()].map((u) => ({
      id: u.id,
      email: u.username,
      name: u.username,
      role: u.role,
      createdAt: u.createdAt,
      entryCount: [...this.rows.values()].filter((r) => r.userId === u.id).length,
      tokenCount: [...this.tokens.values()].filter((t) => t.userId === u.id && !t.revoked)
        .length,
    }));
  }

  async listOwnedProjects(userId: string) {
    return [...this.projects.values()].filter((p) => p.ownerUserId === userId).map((p) => p.id);
  }

  async deleteUserData(userId: string) {
    if ((await this.listOwnedProjects(userId)).length > 0) {
      return {
        deleted: false,
        entriesRemoved: 0,
        tokensRemoved: 0,
        reason: "user still owns project(s)",
      };
    }
    let entriesRemoved = 0;
    for (const [eid, r] of [...this.rows.entries()]) {
      if (r.userId === userId) { this.rows.delete(eid); entriesRemoved++; }
    }
    this.relations = this.relations.filter((r) => r.userId !== userId);
    let tokensRemoved = 0;
    for (const [tk, v] of [...this.tokens.entries()]) {
      if (v.userId === userId) { this.tokens.delete(tk); tokensRemoved++; }
    }
    for (const [pid, members] of this.projectMembers.entries()) {
      members.delete(userId);
    }
    for (const [sid, s] of [...this.sessions.entries()]) {
      if (s.userId === userId) this.sessions.delete(sid);
    }
    this.users.delete(userId);
    return { deleted: true, entriesRemoved, tokensRemoved };
  }

  async deleteUser(id: string) {
    return this.users.delete(id);
  }

  async setUserRole(id: string, role: "admin" | "user", userId: string | null) {
    const u = this.users.get(id);
    if (!u) return false;
    u.role = role;
    u.userId = userId;
    return true;
  }

  async countAdmins() {
    let n = 0;
    for (const u of this.users.values()) if (u.role === "admin") n++;
    return n;
  }

  async createSession(userId: string, ttlMs: number) {
    const token = "ns_test_" + Math.random().toString(36).slice(2, 18);
    const expiresAt = new Date(Date.now() + ttlMs);
    this.sessions.set(token, { userId, expiresAt });
    const u = this.users.get(userId);
    if (u) u.lastLoginAt = new Date();
    return { token, expiresAt };
  }

  async resolveSession(plaintext: string) {
    const s = this.sessions.get(plaintext);
    if (!s || s.expiresAt < new Date()) return null;
    const u = this.users.get(s.userId);
    if (!u) return null;
    return {
      user: { id: u.id, username: u.username, role: u.role, userId: u.userId },
    };
  }

  async revokeSession(plaintext: string) {
    return this.sessions.delete(plaintext);
  }

  // ─── Audit log ────────────────────────────────────────────────────────
  auditEntries: Array<{
    id: number;
    ts: Date;
    actorUserId: string | null;
    actorLabel: string;
    action: string;
    target: string | null;
    metadata: Record<string, unknown> | null;
    requestIp: string | null;
  }> = [];

  async writeAudit(entry: {
    actorUserId?: string | null;
    actorLabel: string;
    action: string;
    target?: string | null;
    metadata?: Record<string, unknown>;
    requestIp?: string | null;
  }) {
    this.auditEntries.push({
      id: this.auditEntries.length + 1,
      ts: new Date(),
      actorUserId: entry.actorUserId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      target: entry.target ?? null,
      metadata: entry.metadata ?? null,
      requestIp: entry.requestIp ?? null,
    });
  }

  async listAuditLog(opts: { limit?: number } = {}) {
    return [...this.auditEntries].reverse().slice(0, opts.limit ?? 200);
  }

  // ─── Projects ───────────────────────────────────────────────────────────

  async createProject(args: { name: string; ownerUserId: string }) {
    const id = ulid();
    const row = { id, ...args, createdAt: new Date() };
    this.projects.set(id, row);
    const m = new Map<string, { role: string; joinedAt: Date }>();
    m.set(args.ownerUserId, { role: "owner", joinedAt: new Date() });
    this.projectMembers.set(id, m);
    return row;
  }

  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }

  async findProjectByName(userId: string, name: string) {
    for (const p of this.projects.values()) {
      if (p.name !== name) continue;
      const m = this.projectMembers.get(p.id)?.get(userId);
      if (m) return p;
    }
    return null;
  }

  // Per-(user, project, hash) shadow map for the dedup fast-path.
  contentHashIdx = new Map<string, string>();
  async findByContentHash(
    userId: string,
    projectId: string | null,
    contentHash: string,
  ): Promise<{ id: string; namespace: string } | null> {
    const id = this.contentHashIdx.get(`${userId}:${projectId ?? ""}:${contentHash}`);
    if (!id) return null;
    // The dedup scope spans namespaces, so the hit's own namespace is the
    // part callers actually need — mirror the real store and report it.
    const row = this.rows.get(id);
    if (!row) {
      // The hash index and the row map are written together; a hash
      // pointing at a missing row means the fake's state is corrupt.
      // Defaulting the namespace here would let namespace-scoping tests
      // pass against a store that cannot exist.
      throw new Error(`FakeWarmStore: contentHashIdx references unknown entry ${id}`);
    }
    return { id, namespace: row.namespace };
  }

  async updateEntry(args: {
    userId: string;
    id: string;
    projectId?: string | null;
    content?: string;
    namespace?: string;
    metadata?: Record<string, unknown>;
    sourceType?: string;
    capturedFrom?: string;
    confidence?: number;
    contentHash?: string;
  }): Promise<boolean> {
    const r = this.rows.get(args.id);
    if (!r) return false;
    const want = args.projectId;
    if (typeof want === "string") {
      if (r.projectId !== want) return false;
    } else {
      if (r.projectId !== null) return false;
      if (r.userId !== args.userId) return false;
    }
    if (args.content !== undefined) r.content = args.content;
    if (args.namespace !== undefined) r.namespace = args.namespace;
    if (args.metadata !== undefined) r.metadata = args.metadata;
    return true;
  }

  // Per-user active project pointer. In-memory; reset between fake
  // instances. Tests that exercise the activate/deactivate flow assert
  // against this directly.
  activeProject = new Map<string, string>();
  async getActiveProject(userId: string): Promise<string | null> {
    return this.activeProject.get(userId) ?? null;
  }
  async setActiveProject(userId: string, projectId: string | null): Promise<void> {
    if (projectId === null) this.activeProject.delete(userId);
    else this.activeProject.set(userId, projectId);
  }

  async recordMetricsSamples(): Promise<void> { /* no-op in fake */ }
  async pruneMetricsSamples(): Promise<number> { return 0; }
  async getMetricsHistory(): Promise<Array<{ sampledAt: Date; queries: number; remembers: number }>> {
    return [];
  }

  async listProjectsForUser(userId: string) {
    const out: Array<{ id: string; name: string; role: string; ownerUserId: string; createdAt: Date }> = [];
    for (const p of this.projects.values()) {
      const m = this.projectMembers.get(p.id)?.get(userId);
      if (m) out.push({ ...p, role: m.role });
    }
    return out;
  }

  async listProjectMembers(projectId: string) {
    const m = this.projectMembers.get(projectId);
    if (!m) return [];
    return [...m.entries()].map(([userId, v]) => {
      const u = this.users.get(userId);
      return {
        userId,
        username: u?.username ?? "(deleted)",
        role: v.role,
        joinedAt: v.joinedAt,
      };
    });
  }

  async addProjectMember(projectId: string, userId: string, role: "owner" | "member") {
    let m = this.projectMembers.get(projectId);
    if (!m) {
      m = new Map();
      this.projectMembers.set(projectId, m);
    }
    if (m.has(userId)) return false;
    m.set(userId, { role, joinedAt: new Date() });
    return true;
  }

  async removeProjectMember(projectId: string, userId: string) {
    const removed = this.projectMembers.get(projectId)?.delete(userId) ?? false;
    return { removed };
  }

  async getProjectMembership(projectId: string, userId: string) {
    const v = this.projectMembers.get(projectId)?.get(userId);
    return v ? { role: v.role } : null;
  }

  async deleteProject(id: string) {
    if (!this.projects.has(id)) return { deleted: false, entriesRemoved: 0 };
    let entriesRemoved = 0;
    for (const [eid, r] of [...this.rows.entries()]) {
      if (r.projectId === id) { this.rows.delete(eid); entriesRemoved++; }
    }
    this.relations = this.relations.filter((r) => r.projectId !== id);
    for (const [tk, v] of [...this.tokens.entries()]) {
      if (v.projectId === id) v.revoked = true; // revoke (don't delete history)
    }
    this.projectMembers.delete(id);
    this.projects.delete(id);
    return { deleted: true, entriesRemoved };
  }
}

export class FakeColdStore {
  vectors = new Map<
    string,
    {
      id: string;
      userId: string;
      projectId: string | null;
      namespace: string;
      embedding: number[];
      payload: Record<string, unknown>;
    }
  >();
  /** Set true to make every operation throw, simulating Qdrant being down. */
  fail = false;

  async ping(): Promise<boolean> { return !this.fail; }

  async upsert(args: {
    userId: string;
    projectId?: string | null;
    id: string;
    namespace: string;
    embedding: number[];
    payload: Record<string, unknown>;
  }) {
    if (this.fail) throw new Error("cold-store unavailable");
    this.vectors.set(args.id, { ...args, projectId: args.projectId ?? null });
  }

  async search(args: {
    userId: string;
    projectId?: string | null;
    namespace: string;
    embedding: number[];
    k: number;
  }) {
    if (this.fail) throw new Error("cold-store unavailable");
    const projectId = args.projectId ?? null;
    const cosine = (a: number[], b: number[]) => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    };
    return [...this.vectors.values()]
      .filter((v) => v.userId === args.userId && v.namespace === args.namespace)
      .filter((v) => (v.projectId ?? null) === projectId)
      .map((v) => ({ id: v.id, score: cosine(v.embedding, args.embedding), payload: v.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.k);
  }


  /** Real Qdrant keeps one collection per (user|project × namespace) and
   *  this lookup only ever reads the caller's collection. Ignoring the
   *  scope here made the fake unable to express any bug where a vector is
   *  looked for in the wrong namespace — it answered "present" for an id
   *  living on a different shelf entirely. */
  async existingIds(
    entries: Array<{ id: string; userId: string; projectId: string | null; namespace: string }>,
  ): Promise<Set<string>> {
    return new Set(
      entries
        .filter((e) => {
          const v = this.vectors.get(e.id);
          return (
            v !== undefined &&
            v.userId === e.userId &&
            v.namespace === e.namespace &&
            (v.projectId ?? null) === (e.projectId ?? null)
          );
        })
        .map((e) => e.id),
    );
  }

  async delete(
    userId: string,
    namespace: string,
    id: string,
    projectId: string | null = null,
  ): Promise<void> {
    if (this.fail) throw new Error("cold-store unavailable");
    const v = this.vectors.get(id);
    if (
      v &&
      v.userId === userId &&
      v.namespace === namespace &&
      (v.projectId ?? null) === projectId
    ) {
      this.vectors.delete(id);
    }
  }

  async deleteAllForProject(projectId: string): Promise<string[]> {
    if (this.fail) return [];
    const dropped = new Set<string>();
    for (const [id, v] of [...this.vectors.entries()]) {
      if (v.projectId === projectId) {
        this.vectors.delete(id);
        dropped.add(`novamem_p_${projectId}_${v.namespace}`);
      }
    }
    return [...dropped];
  }

  async deleteAllForUser(userId: string): Promise<string[]> {
    if (this.fail) throw new Error("cold store down");
    const dropped = new Set<string>();
    for (const [id, v] of [...this.vectors.entries()]) {
      if (v.userId === userId && !v.projectId) {
        this.vectors.delete(id);
        dropped.add(`novamem_u_${userId}_${v.namespace}`);
      }
    }
    return [...dropped];
  }
}


export class FakeEmbedder implements Embedder {
  readonly dimensions = 4;
  readonly modelId = "fake:test-embedder";
  /** Maps content text → embedding for predictable cosine results. */
  table = new Map<string, number[]>();
  /** Records the `kind` of each call so tests can assert that queries and
   *  documents are embedded on their respective sides of an asymmetric
   *  retrieval model. */
  calls: Array<{ input: string[]; kind: "query" | "document" }> = [];
  /** Simulate an unreachable embeddings host. The real adapter throws on
   *  a failed fetch / non-2xx, so the fake throws too — a fake that
   *  returned `[]` instead would let the code under test pass without
   *  ever exercising the path that matters. */
  fail = false;

  async embed(
    input: string | string[],
    kind: "query" | "document" = "document",
  ): Promise<number[][]> {
    const arr = Array.isArray(input) ? input : [input];
    this.calls.push({ input: arr, kind });
    if (this.fail) throw new Error("embeddings http 000: connection refused");
    return arr.map((s) => this.table.get(s) ?? this.deterministic(s));
  }

  /** Cheap stable hash → 4-dim unit vector so different strings get
   *  different but consistent embeddings without needing a real model. */
  private deterministic(s: string): number[] {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < s.length; i++) {
      v[i % 4] = (v[i % 4] ?? 0) + s.charCodeAt(i);
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

/** Convenience cast helpers — the engine uses concrete class types so we
 *  cast our fakes through `unknown`. The structural surface matches. */
export const asWarm = (f: FakeWarmStore): WarmStore => f as unknown as WarmStore;
export const asCold = (f: FakeColdStore): ColdStore => f as unknown as ColdStore;

export interface MakeEngineOpts {
  /** Absolute cosine floor for vector-only search candidates. Defaults
   *  to 0 in tests — see the note in `makeEngine`. */
  minVectorScore?: number;
  /** Max accepted content length; 0 disables the check. */
  maxContentChars?: number;
  /** Deployment-specific high-relevance terms for the worthiness scorer. */
  personalTerms?: readonly string[];
  /** Forwarded to `MemoryEngine`. */
  defaultEffectiveDays?: number;
  /** When true, builds a `MetricsCollector`, binds gauge sources to the
   *  fake stores and wires it into the engine. Default false. */
  withMetrics?: boolean;
  /** Inject a fact extractor to exercise the single-pass write-time
   *  extraction and, optionally, dream-cycle consolidation. Typed against
   *  the real contract — a stub that drifts from `FactExtractor` should
   *  fail to compile rather than fail at runtime. `extract` is required;
   *  `consolidate` is optional, and the engine treats its absence as the
   *  consolidation phase being configured off. */
  extractor?: Pick<import("./engine/fact-extractor.js").FactExtractor, "extract"> &
    Partial<Pick<import("./engine/fact-extractor.js").FactExtractor, "consolidate">>;
  /** Inject a Phase 5 reranker stub; absent = feature unconfigured. */
  reranker?: import("./engine/reranker.js").SearchReranker;
  /** Vector-neighbour edges per remember; 0 disables enrichment. */
  graphLinkFanout?: number;
}

export interface MakeEngineResult {
  engine: MemoryEngine;
  warm: FakeWarmStore;
  cold: FakeColdStore;
  embedder: FakeEmbedder;
  metrics: MetricsCollector | undefined;
}

/** Shared engine wiring for tests. Mirrors what `http.test.ts:makeApp`,
 *  `mcp.test.ts` and `engine.test.ts:bench` were doing inline. */
export function makeEngine(opts: MakeEngineOpts = {}): MakeEngineResult {
  const warm = new FakeWarmStore();
  const cold = new FakeColdStore();
  const embedder = new FakeEmbedder();
  const metrics = opts.withMetrics ? new MetricsCollector() : undefined;
  if (metrics) {
    metrics.bindGaugeSources({
      warmEntries: async () => [...warm.rows.values()].filter((r) => !r.cold).length,
      coldEntries: async () => [...warm.rows.values()].filter((r) => r.cold).length,
      graphEdges: async () => warm.relations.length,
      orphansPending: async () => warm.coldOrphans.size,
      pendingEmbeddings: async () => warm.countPendingEmbedding(),
      pendingFacts: async () => warm.countPendingFacts(),
    });
  }
  const engine = new MemoryEngine({
    reranker: opts.reranker,
    graphLinkFanout: opts.graphLinkFanout,
    warm: asWarm(warm),
    cold: asCold(cold),
    embedder,
    defaultEffectiveDays: opts.defaultEffectiveDays,
    metrics,
    // The fake embedder produces 4-dim vectors whose cosines cluster
    // high, so the production noise floor would filter almost everything
    // out. Tests that care about the floor pass their own value.
    minVectorScore: opts.minVectorScore ?? 0,
    maxContentChars: opts.maxContentChars,
    personalTerms: opts.personalTerms,
    // The engine's field is the full class; a stub implementing the two
    // methods it actually calls is sufficient and is type-checked as such
    // by MakeEngineOpts above.
    extractor: opts.extractor as import("./engine/fact-extractor.js").FactExtractor | undefined,
  });
  return { engine, warm, cold, embedder, metrics };
}
