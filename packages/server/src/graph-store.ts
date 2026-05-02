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

  /** Every Memory node carries `tenant` and (optionally) `project` properties.
   *  Tenant-isolation traversals filter on `tenant`; project-isolation
   *  traversals additionally filter on `project`. Cross-tenant /
   *  cross-project edges can't be created (nodes are scoped by both keys)
   *  and can't be followed (MATCH joins on whichever key the caller passed). */
  async addEdge(
    tenantId: string,
    fromId: string,
    toId: string,
    relation: string,
    strength = 1.0,
    projectId: string | null = null,
  ): Promise<void> {
    if (!this.graph) return;
    await this.graph.query(
      "MERGE (a:Memory {id: $from, tenant: $tenant, project: $project}) " +
        "MERGE (b:Memory {id: $to, tenant: $tenant, project: $project}) " +
        "MERGE (a)-[r:RELATES {kind: $rel}]->(b) SET r.strength = $strength",
      {
        params: {
          from: fromId,
          to: toId,
          tenant: tenantId,
          project: projectId ?? "",
          rel: relation,
          strength,
        },
      },
    );
  }

  /** Drop a node and all its incident edges. Called on `forget()` so graph
   *  state stays consistent with warm/cold deletions. */
  async removeNode(tenantId: string, id: string): Promise<void> {
    if (!this.graph) return;
    await this.graph.query("MATCH (n:Memory {id: $id, tenant: $tenant}) DETACH DELETE n", {
      params: { id, tenant: tenantId },
    });
  }

  /** Return graph-neighbour ids for a seed id, with edge strengths as scores.
   *  Filters on tenant + project (project = "" for tenant-wide entries). */
  async neighbors(
    tenantId: string,
    seedId: string,
    depth = 1,
    limit = 20,
    projectId: string | null = null,
  ): Promise<Array<{ id: string; score: number }>> {
    if (!this.graph) return [];
    const project = projectId ?? "";
    const cypher = `MATCH (a:Memory {id: $id, tenant: $tenant, project: $project})-[r:RELATES*1..${depth}]-(b:Memory)
                    WHERE b.tenant = $tenant AND b.project = $project
                    RETURN b.id AS id, MAX(reduce(s = 1.0, e IN r | s * e.strength)) AS score
                    LIMIT ${limit}`;
    const r = await this.graph.query<{ id: string; score: number }>(cypher, {
      params: { id: seedId, tenant: tenantId, project },
    });
    return (r.data ?? []).map((row) => ({ id: row.id, score: Number(row.score ?? 0) }));
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }

  /** Drop every Memory node (and its edges) belonging to a given tenant.
   *  Called when a tenant is deleted — keeps the graph aligned with the
   *  warm + cold purges. No-op when the graph is unreachable: the warm-side
   *  delete is the source of truth, and the next time the graph comes back
   *  the orphaned nodes are harmless (they're filterable by tenant anyway,
   *  but we still try to clean them now). */
  async removeAllForTenant(tenantId: string): Promise<void> {
    if (!this.graph || !this.connected) return;
    try {
      await this.graph.query("MATCH (n:Memory {tenant: $tenant}) DETACH DELETE n", {
        params: { tenant: tenantId },
      });
    } catch {
      // Best-effort — the warm/cold purge already succeeded.
    }
  }

  /** Drop every Memory node belonging to a project. Used when a project is
   *  deleted, to keep the graph aligned with the warm + cold purges. */
  async removeAllForProject(projectId: string): Promise<void> {
    if (!this.graph || !this.connected) return;
    try {
      await this.graph.query("MATCH (n:Memory {project: $project}) DETACH DELETE n", {
        params: { project: projectId },
      });
    } catch {
      // Best-effort.
    }
  }

  /** Total RELATES edge count across all tenants — used by the admin
   *  metrics gauge. Returns null when the graph is unreachable so the
   *  caller can render "—" instead of zero. */
  async edgeCount(): Promise<number | null> {
    if (!this.graph || !this.connected) return null;
    try {
      const r = await this.graph.query<{ count: number }>(
        "MATCH ()-[r:RELATES]->() RETURN count(r) AS count",
      );
      const n = Number(r.data?.[0]?.count ?? 0);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.db) await this.db.close();
    this.db = null;
    this.graph = null;
    this.connected = false;
  }
}
