/**
 * Lightweight in-memory fakes for the engine's three stores + embedder.
 * Keeps tests fast and deterministic without docker / postgres / qdrant.
 */

import type { ColdStore } from "./cold-store.js";
import type { GraphStore } from "./graph-store.js";
import type { Embedder } from "./embeddings.js";
import type { WarmStore } from "./warm-store/index.js";
import { ulid } from "ulid";

export interface FakeWarmRow {
  id: string;
  content: string;
  namespace: string;
  source: string;
  agentName: string | null;
  metadata: Record<string, unknown>;
  cold: boolean;
  createdAt: Date;
  hits: number;
  lastAccessed: Date;
}

export class FakeWarmStore {
  rows = new Map<string, FakeWarmRow>();
  decayRunsInserted = 0;
  decayRunsUpdated = 0;
  pool = {
    /** Fake the pool query surface used by engine.recent + engine.forget +
     *  engine.decay. Only the queries the engine actually issues are wired —
     *  anything else throws so tests fail loudly on unexpected SQL. */
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
      // recent()
      if (sql.includes("FROM memory_entries") && sql.includes("WHERE namespace = $1")) {
        const namespace = String(params[0]);
        const k = Number(params[1]);
        const since = params[2] ? new Date(String(params[2])) : null;
        const filtered = [...this.rows.values()]
          .filter((r) => r.namespace === namespace)
          .filter((r) => !since || r.createdAt >= since)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, k)
          .map((r) => ({
            id: r.id,
            content: r.content,
            namespace: r.namespace,
            source: r.source,
            metadata: r.metadata,
            cold: r.cold,
            created_at: r.createdAt,
          }));
        return { rows: filtered };
      }
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
      // forget()
      if (sql.startsWith("DELETE FROM memory_fts")) return { rows: [] };
      if (sql.startsWith("DELETE FROM memory_access")) return { rows: [] };
      if (sql.startsWith("DELETE FROM memory_entries")) {
        this.rows.delete(String(params[0]));
        return { rows: [] };
      }
      throw new Error(`fake pool: unhandled SQL — ${sql.slice(0, 60)}`);
    },
  };

  async ping(): Promise<boolean> { return true; }
  async close(): Promise<void> { /* no-op */ }

  async insertEntry(args: {
    content: string;
    namespace: string;
    source: string;
    agentName?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = ulid();
    this.rows.set(id, {
      id,
      content: args.content,
      namespace: args.namespace,
      source: args.source,
      agentName: args.agentName ?? null,
      metadata: args.metadata ?? {},
      cold: false,
      createdAt: new Date(),
      hits: 0,
      lastAccessed: new Date(),
    });
    return id;
  }

  async ftsSearch(args: {
    query: string;
    namespace: string;
    k: number;
    agentName?: string | null;
  }): Promise<Array<{ id: string; score: number }>> {
    const q = args.query.toLowerCase();
    const matches = [...this.rows.values()]
      .filter((r) => r.namespace === args.namespace)
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

  async getEntry(id: string) {
    const r = this.rows.get(id);
    if (!r) return undefined;
    return {
      id: r.id,
      content: r.content,
      namespace: r.namespace,
      source: r.source,
      agentName: r.agentName,
      metadata: r.metadata,
      cold: r.cold,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
    };
  }

  async bumpHits(id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) {
      r.hits += 1;
      r.lastAccessed = new Date();
    }
  }

  async listColdCandidates(_effectiveDays: number, _limit = 1000) {
    const now = Date.now();
    return {
      rows: [...this.rows.values()]
        .filter((r) => !r.cold)
        .map((r) => ({
          id: r.id,
          hits: r.hits,
          idle_days: (now - r.lastAccessed.getTime()) / (1000 * 60 * 60 * 24),
        })),
    };
  }

  async markCold(id: string, cold: boolean): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.cold = cold;
  }

  async stats() {
    const rows: Array<{ namespace: string; cold: boolean; count: string }> = [];
    const groups = new Map<string, number>();
    for (const r of this.rows.values()) {
      const key = `${r.namespace}::${r.cold}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    for (const [key, count] of groups) {
      const [namespace, coldStr] = key.split("::");
      rows.push({ namespace: namespace!, cold: coldStr === "true", count: String(count) });
    }
    return { rows, lastDecayAt: null };
  }
}

export class FakeColdStore {
  vectors = new Map<string, { id: string; namespace: string; embedding: number[]; payload: Record<string, unknown> }>();
  /** Set true to make every operation throw, simulating Qdrant being down. */
  fail = false;

  async ping(): Promise<boolean> { return !this.fail; }

  async upsert(args: { id: string; namespace: string; embedding: number[]; payload: Record<string, unknown> }) {
    if (this.fail) throw new Error("cold-store unavailable");
    this.vectors.set(args.id, args);
  }

  async search(args: { namespace: string; embedding: number[]; k: number }) {
    if (this.fail) throw new Error("cold-store unavailable");
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
      .filter((v) => v.namespace === args.namespace)
      .map((v) => ({ id: v.id, score: cosine(v.embedding, args.embedding), payload: v.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.k);
  }

  async delete(namespace: string, id: string): Promise<void> {
    if (this.fail) throw new Error("cold-store unavailable");
    const v = this.vectors.get(id);
    if (v && v.namespace === namespace) this.vectors.delete(id);
  }
}

export class FakeGraphStore {
  edges = new Map<string, Array<{ to: string; strength: number }>>();
  connected = true;

  isConnected(): boolean { return this.connected; }
  async ping(): Promise<boolean> { return this.connected; }

  async addEdge(from: string, to: string, _relation: string, strength = 1): Promise<void> {
    const cur = this.edges.get(from) ?? [];
    cur.push({ to, strength });
    this.edges.set(from, cur);
  }

  async neighbors(seedId: string, _depth = 1, k = 10): Promise<Array<{ id: string; score: number }>> {
    const cur = this.edges.get(seedId) ?? [];
    return cur.slice(0, k).map((e) => ({ id: e.to, score: e.strength }));
  }
}

export class FakeEmbedder implements Embedder {
  readonly dimensions = 4;
  /** Maps content text → embedding for predictable cosine results. */
  table = new Map<string, number[]>();

  async embed(input: string | string[]): Promise<number[][]> {
    const arr = Array.isArray(input) ? input : [input];
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
export const asGraph = (f: FakeGraphStore): GraphStore => f as unknown as GraphStore;
