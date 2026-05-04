/**
 * Graph store — FalkorDB-backed relation graph. Optional; if disabled, the
 * engine falls back to vector + keyword only and emits a `degraded: true`
 * flag in search results.
 */

import { FalkorDB, type Graph } from "falkordb";

/** Minimal logger surface — structurally compatible with Pino /
 *  Fastify's logger. Object-first: `(obj, msg)` is the idiomatic Pino
 *  call shape. Defaults to console when no logger is supplied. */
export interface GraphStoreLogger {
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
}

export interface GraphStoreConfig {
  url: string;
  graphName?: string;
  /** Optional Pino-compatible logger. Defaults to console. */
  logger?: GraphStoreLogger;
}

export class GraphStore {
  private db: FalkorDB | null = null;
  private graph: Graph | null = null;
  private readonly url: string;
  private readonly graphName: string;
  private logger: GraphStoreLogger;
  private connected = false;

  constructor(cfg: GraphStoreConfig) {
    this.url = cfg.url;
    this.graphName = cfg.graphName ?? "novamem";
    this.logger = cfg.logger ?? {
      // eslint-disable-next-line no-console
      warn: (...args: unknown[]) => console.warn(...(args as [unknown, ...unknown[]])),
    } as GraphStoreLogger;
  }

  /** Replace the logger after construction — main.ts uses this to swap
   *  the boot-time console fallback for `app.log.child({ component:
   *  "graph-store" })` once the Fastify Pino logger exists. */
  setLogger(logger: GraphStoreLogger): void {
    this.logger = logger;
  }

  async connect(): Promise<boolean> {
    try {
      this.db = await FalkorDB.connect({ url: this.url });
      this.graph = this.db.selectGraph(this.graphName);
      this.connected = true;
      return true;
    } catch (err) {
      // Surface the cause so operators can distinguish wrong URL / auth /
      // DNS without spelunking. Failure mode is degraded-mode search;
      // we still return false rather than throw.
      this.logger.warn(
        { url: this.url, err: (err as Error).message },
        "graph-store connect failed",
      );
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Every Memory node carries `user` and (optionally) `project` properties.
   *  User-isolation traversals filter on `user`; project-isolation
   *  traversals additionally filter on `project`. Cross-user /
   *  cross-project edges can't be created (nodes are scoped by both keys)
   *  and can't be followed (MATCH joins on whichever key the caller passed). */
  async addEdge(
    userId: string,
    fromId: string,
    toId: string,
    relation: string,
    strength = 1.0,
    projectId: string | null = null,
  ): Promise<void> {
    if (!this.graph) return;
    await this.graph.query(
      "MERGE (a:Memory {id: $from, user: $user, project: $project}) " +
        "MERGE (b:Memory {id: $to, user: $user, project: $project}) " +
        "MERGE (a)-[r:RELATES {kind: $rel}]->(b) SET r.strength = $strength",
      {
        params: {
          from: fromId,
          to: toId,
          user: userId,
          project: projectId ?? "",
          rel: relation,
          strength,
        },
      },
    );
  }

  /** Batch variant of `addEdge` — one round-trip for all neighbour links
   *  off a single source id. Used by `engine.linkVectorNeighbors` to
   *  collapse `graphLinkFanout` round-trips per `remember()` to one
   *  (review finding P1-P3 / P-H4). */
  async addEdgesBatch(
    userId: string,
    fromId: string,
    edges: Array<{ to: string; relation: string; strength?: number }>,
    projectId: string | null = null,
  ): Promise<void> {
    if (!this.graph || edges.length === 0) return;
    const params = {
      from: fromId,
      user: userId,
      project: projectId ?? "",
      edges: edges.map((e) => ({
        to: e.to,
        rel: e.relation,
        strength: e.strength ?? 1.0,
      })),
    };
    await this.graph.query(
      "MERGE (a:Memory {id: $from, user: $user, project: $project}) " +
        "WITH a UNWIND $edges AS edge " +
        "MERGE (b:Memory {id: edge.to, user: $user, project: $project}) " +
        "MERGE (a)-[r:RELATES {kind: edge.rel}]->(b) " +
        "SET r.strength = edge.strength",
      { params },
    );
  }

  /** Drop a node and all its incident edges. Called on `forget()` so graph
   *  state stays consistent with warm/cold deletions. */
  async removeNode(userId: string, id: string): Promise<void> {
    if (!this.graph) return;
    await this.graph.query("MATCH (n:Memory {id: $id, user: $user}) DETACH DELETE n", {
      params: { id, user: userId },
    });
  }

  /** Return graph-neighbour ids for a seed id, with edge strengths as scores.
   *  Filters on user + project (project = "" for user-wide entries). */
  async neighbors(
    userId: string,
    seedId: string,
    depth = 1,
    limit = 20,
    projectId: string | null = null,
  ): Promise<Array<{ id: string; score: number }>> {
    if (!this.graph) return [];
    // Defensive clamp — `${limit}` is interpolated into Cypher (FalkorDB
    // doesn't bind LIMIT). Upstream Zod gates already cap k, but pinning
    // the bound here removes the implicit coupling.
    limit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const project = projectId ?? "";
    // The depth-1 hot path uses a single relationship variable so the
    // server returns a scalar Edge directly. This avoids a falkordb-driver
    // bug where `RELATES*1..N` decodes as Edge for paths of length 1 and
    // the client throws "Type mismatch: expected List or Null but was
    // Edge" — the engine swallowed that and reported degraded:true on
    // every search. Multi-hop traversal still uses the path form.
    const cypher =
      depth <= 1
        ? `MATCH (a:Memory {id: $id, user: $user, project: $project})-[r:RELATES]-(b:Memory)
             WHERE b.user = $user AND b.project = $project
             RETURN b.id AS id, MAX(r.strength) AS score
             LIMIT ${limit}`
        : `MATCH (a:Memory {id: $id, user: $user, project: $project})-[r:RELATES*1..${depth}]-(b:Memory)
             WHERE b.user = $user AND b.project = $project
             RETURN b.id AS id, MAX(reduce(s = 1.0, e IN r | s * e.strength)) AS score
             LIMIT ${limit}`;
    const r = await this.graph.query<{ id: string; score: number }>(cypher, {
      params: { id: seedId, user: userId, project },
    });
    return (r.data ?? []).map((row) => ({ id: row.id, score: Number(row.score ?? 0) }));
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }

  /** Drop every Memory node belonging to a project. Returns `true` only
   *  when the delete actually ran — silently swallowing errors used to
   *  make the engine report `graphCleared: true` falsely (P1-A6). */
  async removeAllForProject(projectId: string): Promise<boolean> {
    if (!this.graph || !this.connected) return false;
    try {
      await this.graph.query("MATCH (n:Memory {project: $project}) DETACH DELETE n", {
        params: { project: projectId },
      });
      return true;
    } catch (err) {
      this.logger.warn(
        { projectId, err: (err as Error).message },
        "graph-store removeAllForProject failed",
      );
      return false;
    }
  }

  /** Total RELATES edge count across all users — used by the admin
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
