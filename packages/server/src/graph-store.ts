/**
 * Graph store — FalkorDB-backed relation graph. Optional; if disabled, the
 * engine falls back to vector + keyword only and emits a `degraded: true`
 * flag in search results.
 */

import { FalkorDB, type Graph } from "falkordb";

export interface GraphStoreConfig {
  url: string;
  graphName?: string;
}

export class GraphStore {
  private db: FalkorDB | null = null;
  private graph: Graph | null = null;
  private readonly url: string;
  private readonly graphName: string;
  private connected = false;

  constructor(cfg: GraphStoreConfig) {
    this.url = cfg.url;
    this.graphName = cfg.graphName ?? "novamem";
  }

  async connect(): Promise<boolean> {
    try {
      this.db = await FalkorDB.connect({ url: this.url });
      this.graph = this.db.selectGraph(this.graphName);
      this.connected = true;
      return true;
    } catch (err) {
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async addEdge(fromId: string, toId: string, relation: string, strength = 1.0): Promise<void> {
    if (!this.graph) return;
    await this.graph.query(
      "MERGE (a:Memory {id: $from}) MERGE (b:Memory {id: $to}) MERGE (a)-[r:RELATES {kind: $rel}]->(b) SET r.strength = $strength",
      { params: { from: fromId, to: toId, rel: relation, strength } },
    );
  }

  /** Return graph-neighbour ids for a seed id, with edge strengths as scores. */
  async neighbors(seedId: string, depth = 1, limit = 20): Promise<Array<{ id: string; score: number }>> {
    if (!this.graph) return [];
    const cypher = `MATCH (a:Memory {id: $id})-[r:RELATES*1..${depth}]-(b:Memory)
                    RETURN b.id AS id, MAX(reduce(s = 1.0, e IN r | s * e.strength)) AS score
                    LIMIT ${limit}`;
    const r = await this.graph.query<{ id: string; score: number }>(cypher, {
      params: { id: seedId },
    });
    return (r.data ?? []).map((row) => ({ id: row.id, score: Number(row.score ?? 0) }));
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }

  async close(): Promise<void> {
    if (this.db) await this.db.close();
    this.db = null;
    this.graph = null;
    this.connected = false;
  }
}
