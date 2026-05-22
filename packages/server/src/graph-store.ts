/**
 * Graph store — FalkorDB-backed relation graph. Optional; if disabled, the
 * engine falls back to vector + keyword only and emits a `degraded: true`
 * flag in search results.
 */

import { FalkorDB, type Graph } from "falkordb";

/** Allowlist for graph-traversal depth. FalkorDB can't bind a path-length
 *  via `$param`, so depth is interpolated directly into Cypher; this list
 *  is the authoritative gate for what's acceptable. We keep it tight
 *  ({1,2,3}) because multi-hop walks scale exponentially and the default
 *  caller only ever asks for depth=1. */
const ALLOWED_GRAPH_DEPTHS = new Set<number>([1, 2, 3]);

/** Validate `depth` and `limit` *before* they're concatenated into a
 *  Cypher string. Throws on non-finite / NaN values, on `depth` outside
 *  the allowlist, and on `limit` outside 1..200. The `limit` check is
 *  deliberately a finiteness assertion only — the caller numerically
 *  clamps the value afterwards; this just stops `NaN`/`Infinity` from
 *  ever reaching the clamp. Exported so unit tests can assert the
 *  contract directly. */
export function validateGraphParams(depth: unknown, limit: unknown): void {
  if (
    typeof depth !== "number" ||
    !Number.isFinite(depth) ||
    !ALLOWED_GRAPH_DEPTHS.has(depth)
  ) {
    throw new Error("invalid graph traversal params");
  }
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("invalid graph traversal params");
  }
}

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
      await this.ensureSchema();
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

  /** Create the indexes that `MERGE (n:Memory {id, user, project})` needs
   *  to avoid a label scan over every Memory node. Without these the
   *  benchmark hot path (`addEdgesBatch`) shows `Node By Label Scan` in
   *  `GRAPH.EXPLAIN` and burns ~380ms p50 per write at ~100k nodes.
   *
   *  Idempotent: FalkorDB returns "already indexed" / "index already
   *  exists" on duplicate creates which we deliberately swallow so the
   *  call is safe to make on every connect. Anything else is logged
   *  but does not fail the connect — degraded perf is acceptable;
   *  refusing to start because of a transient index race is not.
   *
   *  We index three single properties (id, user, project) rather than a
   *  composite. FalkorDB picks one based on selectivity; `id` will be
   *  near-unique so MERGE narrows to ~1 candidate in O(log N), and the
   *  remaining `user`/`project` predicates are evaluated as a property
   *  filter on the tiny candidate set. */
  private async ensureSchema(): Promise<void> {
    if (!this.graph) return;
    const stmts = [
      "CREATE INDEX FOR (n:Memory) ON (n.id)",
      "CREATE INDEX FOR (n:Memory) ON (n.user)",
      "CREATE INDEX FOR (n:Memory) ON (n.project)",
    ];
    for (const stmt of stmts) {
      try {
        await this.graph.query(stmt);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        // FalkorDB returns one of these on a duplicate index create. They
        // are the *expected* outcome whenever the graph already exists
        // (i.e. on every restart after the first), so logging them as
        // warnings would generate noise on every pod start.
        if (/already\s+(indexed|exists)/i.test(msg)) continue;
        this.logger.warn(
          { stmt, err: msg },
          "graph-store ensureSchema: index create failed",
        );
      }
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
    /** Arch-plan Phase 3: bitemporal validity stamps. Default to "now,
     *  open-ended". Callers can supply explicit ranges for historical
     *  imports or supersedes. */
    validFromMs: number = Date.now(),
    validToMs: number | null = null,
  ): Promise<void> {
    if (!this.graph) return;
    await this.graph.query(
      "MERGE (a:Memory {id: $from, user: $user, project: $project}) " +
        "MERGE (b:Memory {id: $to, user: $user, project: $project}) " +
        "MERGE (a)-[r:RELATES {kind: $rel}]->(b) " +
        "SET r.strength = $strength, r.validFrom = $validFrom, r.validTo = $validTo",
      {
        params: {
          from: fromId,
          to: toId,
          user: userId,
          project: projectId ?? "",
          rel: relation,
          strength,
          validFrom: validFromMs,
          validTo: validToMs ?? 0,
        },
      },
    );
  }

  /** Batch variant of `addEdge` — one round-trip for all neighbour links
   *  off a single source id. Used by `engine.linkVectorNeighbors` to
   *  collapse `graphLinkFanout` round-trips per `remember()` to one. */
  async addEdgesBatch(
    userId: string,
    fromId: string,
    edges: Array<{ to: string; relation: string; strength?: number; validFromMs?: number; validToMs?: number | null }>,
    projectId: string | null = null,
  ): Promise<void> {
    if (!this.graph || edges.length === 0) return;
    const now = Date.now();
    const params = {
      from: fromId,
      user: userId,
      project: projectId ?? "",
      edges: edges.map((e) => ({
        to: e.to,
        rel: e.relation,
        strength: e.strength ?? 1.0,
        validFrom: e.validFromMs ?? now,
        validTo: e.validToMs ?? 0,
      })),
    };
    await this.graph.query(
      "MERGE (a:Memory {id: $from, user: $user, project: $project}) " +
        "WITH a UNWIND $edges AS edge " +
        "MERGE (b:Memory {id: edge.to, user: $user, project: $project}) " +
        "MERGE (a)-[r:RELATES {kind: edge.rel}]->(b) " +
        "SET r.strength = edge.strength, r.validFrom = edge.validFrom, r.validTo = edge.validTo",
      { params },
    );
  }

  /** Arch-plan Phase 3: supersede a fact-edge — mark all matching active
   *  edges (validTo=0 → currently valid) as ending at `atMs`, then add a
   *  new active edge from→toNew with validFrom=atMs.
   *  This is the clean "fact changed at T" path: the OLD knowledge stays
   *  queryable with `asOf < atMs`, and the NEW knowledge wins for
   *  `asOf >= atMs`. */
  async supersedeEdge(
    userId: string,
    fromId: string,
    toIdNew: string,
    relation: string,
    strength = 1.0,
    projectId: string | null = null,
    atMs: number = Date.now(),
  ): Promise<void> {
    if (!this.graph) return;
    // Close out any open edges with the same (from, relation).
    await this.graph.query(
      "MATCH (a:Memory {id: $from, user: $user, project: $project})-[r:RELATES {kind: $rel}]->() " +
        "WHERE r.validTo = 0 SET r.validTo = $at",
      {
        params: {
          from: fromId,
          user: userId,
          project: projectId ?? "",
          rel: relation,
          at: atMs,
        },
      },
    );
    // Open a new edge to the new target.
    await this.addEdge(userId, fromId, toIdNew, relation, strength, projectId, atMs, null);
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
    /** Arch-plan Phase 3: bitemporal `as-of` filter. When provided, the
     *  traversal only follows edges that were valid at this instant
     *  (validFrom <= asOf AND (validTo = 0 OR validTo >= asOf)). Edges
     *  written before Phase 3 had no temporal columns and so default to
     *  always-valid (validFrom = 0, validTo = 0). */
    asOfMs: number | null = null,
  ): Promise<Array<{ id: string; score: number }>> {
    if (!this.graph) return [];
    // ── Cypher param hardening (issue #44) ─────────────────────────────
    // FalkorDB cannot bind LIMIT or relationship-path length (`*1..N`)
    // through `$param` placeholders, so we MUST interpolate `depth` and
    // `limit` into the Cypher string. To keep that safe we:
    //   1. Reject non-finite / NaN inputs up front (a stray `NaN` would
    //      otherwise stringify to `"NaN"` and either error out leaking a
    //      stack trace or — worse if templating ever changes — open a
    //      structural-injection sink.
    //   2. Constrain `depth` to a tiny allowlist `{1, 2, 3}` because
    //      multi-hop traversal cost is exponential and only depth=1 is
    //      used on the hot path; larger depths are explicit power-user
    //      requests, not arbitrary numbers.
    //   3. Numeric-clamp `limit` into 1..200 after the finiteness check.
    // Any callers passing untrusted values will throw before we ever
    // build a query string.
    validateGraphParams(depth, limit);
    limit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const project = projectId ?? "";
    // The depth-1 hot path uses a single relationship variable so the
    // server returns a scalar Edge directly. This avoids a falkordb-driver
    // bug where `RELATES*1..N` decodes as Edge for paths of length 1 and
    // the client throws "Type mismatch: expected List or Null but was
    // Edge" — the engine swallowed that and reported degraded:true on
    // every search.
    //
    // For depth ≥ 2 the variable-length pattern `[r:RELATES*1..N]` causes
    // a related decoder error: "expected List or Null but was Path" —
    // the driver receives a Path-typed value where the result-set
    // descriptor expected a list. The fix is to bind the path with
    // `MATCH p = …`, project the strengths into a primitive list via a
    // list comprehension `[rel IN relationships(p) | rel.strength]`,
    // and aggregate the scalars in a follow-up WITH. That way no
    // Path / Relationship value ever reaches the wire as a column,
    // and the client decodes pure numbers.
    // `b.id <> $id` excludes the seed itself from results — without it,
    // a self-loop edge (fromId === toId) would surface the seed as its
    // own neighbour. The depth ≥ 2 branch has the same predicate.
    // Arch-plan Phase 3: optional as-of validity filter. When asOfMs is
    // null we don't filter (backwards-compat with pre-Phase-3 edges that
    // have no validFrom/validTo set — Cypher's coalesce treats them as
    // always-valid).
    const tempCond =
      asOfMs === null
        ? ""
        : " AND coalesce(r.validFrom, 0) <= $asOf AND (coalesce(r.validTo, 0) = 0 OR coalesce(r.validTo, 0) >= $asOf)";
    const tempCondPath =
      asOfMs === null
        ? ""
        : " AND ALL(rel IN relationships(p) WHERE coalesce(rel.validFrom, 0) <= $asOf AND (coalesce(rel.validTo, 0) = 0 OR coalesce(rel.validTo, 0) >= $asOf))";
    const cypher =
      depth <= 1
        ? `MATCH (a:Memory {id: $id, user: $user, project: $project})-[r:RELATES]-(b:Memory)
             WHERE b.user = $user AND b.project = $project AND b.id <> $id${tempCond}
             RETURN b.id AS id, MAX(r.strength) AS score
             LIMIT ${limit}`
        : `MATCH p = (a:Memory {id: $id, user: $user, project: $project})-[:RELATES*1..${depth}]-(b:Memory)
             WHERE b.user = $user AND b.project = $project AND b.id <> $id${tempCondPath}
             WITH b.id AS id,
                  reduce(s = 1.0, x IN [rel IN relationships(p) | rel.strength] | s * x) AS pathScore
             RETURN id, MAX(pathScore) AS score
             LIMIT ${limit}`;
    const r = await this.graph.query<{ id: string; score: number }>(cypher, {
      params: { id: seedId, user: userId, project, asOf: asOfMs ?? 0 },
    });
    return (r.data ?? []).map((row) => ({ id: row.id, score: Number(row.score ?? 0) }));
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }

  /** Drop every Memory node belonging to a project. Returns `true` only
   *  when the delete actually ran — silently swallowing errors used to
   *  make the engine report `graphCleared: true` falsely. */
  async removeAllForProject({
    userId,
    projectId,
  }: {
    userId: string;
    projectId: string;
  }): Promise<boolean> {
    if (!this.graph || !this.connected) return false;
    try {
      // Defence-in-depth user scoping (issue #45): even though the HTTP
      // layer verifies the caller owns the project, double-keying the
      // delete on `user` ensures a malformed Cypher template or a future
      // caller mistake can't reach across user boundaries.
      await this.graph.query(
        "MATCH (n:Memory {user: $user, project: $project}) DETACH DELETE n",
        { params: { user: userId, project: projectId } },
      );
      return true;
    } catch (err) {
      this.logger.warn(
        { userId, projectId, err: (err as Error).message },
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
