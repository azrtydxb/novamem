/**
 * Cold store — Qdrant-backed vector index. One collection per namespace,
 * created lazily on first write.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";

/** Derive a deterministic UUIDv5-shaped string from any id. Qdrant point ids
 *  must be unsigned ints or UUIDs — our ULIDs are neither. We hash and format
 *  as a UUID so point ids are stable and reproducible. The original id is
 *  preserved in the point payload as `entryId` for lookups. */
function ulidToUuid(id: string): string {
  const hex = createHash("sha1").update(id).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isCollectionAlreadyExistsError(err: unknown): boolean {
  const maybe = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  const status = maybe.status ?? maybe.statusCode;
  if (status === 409 || status === "409") return true;
  const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
  return message.includes("collection") && message.includes("already exists");
}

function errorText(err: unknown): string {
  const maybe = err as { message?: unknown; data?: { status?: { error?: unknown } } };
  return [maybe.message, maybe.data?.status?.error]
    .filter((v): v is string => typeof v === "string")
    .join("\n")
    .toLowerCase();
}

function isRetryableQdrantUpsertError(err: unknown): boolean {
  const maybe = err as { status?: unknown; statusCode?: unknown };
  const status = maybe.status ?? maybe.statusCode;
  if (status !== 500 && status !== "500") return false;
  const text = errorText(err);
  return text.includes("failed to apply operation") && text.includes("please retry");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ColdStoreConfig {
  url: string;
  /** Embedding vector dimensionality. Configurable for swappable embedders. */
  vectorSize: number;
  /** Per-request timeout in ms. Without it a stalled Qdrant holds every
   *  search open — the engine's per-tier `.catch` degrades on errors,
   *  not on hangs. Default 15s. */
  timeoutMs?: number;
}

export class ColdStore {
  private readonly client: QdrantClient;
  private readonly seenCollections = new Set<string>();
  private readonly vectorSize: number;

  constructor(cfg: ColdStoreConfig) {
    // NOTE: the *client constructor's* `timeout` is milliseconds (it
    // feeds `setTimeout(() => controller.abort(), timeout)`, default
    // 300_000). Don't confuse it with the per-request `timeout` option on
    // individual search calls, which Qdrant defines in seconds.
    this.client = new QdrantClient({ url: cfg.url, timeout: cfg.timeoutMs ?? 15_000 });
    this.vectorSize = cfg.vectorSize;
  }

  /** Collection naming embeds user + project so vector leakage is
   *  structurally impossible — there's literally no shared collection to
   *  accidentally search across either boundary.
   *
   *  - User-wide entries (no project): `novamem_u_<user>_<namespace>`
   *  - Project-scoped entries: `novamem_p_<project>_<namespace>`
   *
   *  Both forms lead with a kind prefix (`u_` / `p_`) so a user id can
   *  never collide with a project id, regardless of slug conventions.
   *  Project membership is cross-user by design, so the user id
   *  intentionally does not appear in project-scoped collection names.
   *
   *  Migration note (issue #20): the legacy unprefixed form
   *  `novamem_<user>_<namespace>` may still exist in deployed Qdrant
   *  clusters. Reads check both names and adopt whichever exists; new
   *  writes go to the `u_` form. Old collections stay in place — there
   *  is no boot-time rename — so a downgrade stays compatible. */
  private collectionFor(userId: string, namespace: string, projectId: string | null = null): string {
    if (projectId) return `novamem_p_${projectId}_${namespace}`;
    return `novamem_u_${userId}_${namespace}`;
  }

  /** Legacy (pre-issue-#20) user-collection name. Used only for read
   *  fallback so already-deployed clusters keep working without a
   *  migration step. Never returned for new writes. */
  private legacyUserCollectionFor(userId: string, namespace: string): string {
    return `novamem_${userId}_${namespace}`;
  }

  /** Resolve every collection that may hold vectors for this scope.
   *
   *  Returns the new `u_`/`p_`-prefixed collection and, for user-scoped
   *  reads, the legacy unprefixed one — *both* when both exist, not just
   *  the preferred one. The previous "prefer primary, fall back to
   *  legacy only if primary is absent" rule created a silent data-loss
   *  window on any cluster that predates the issue-#20 rename: the first
   *  post-migration write created the `u_` collection, and from that
   *  moment every pre-migration vector became unsearchable *and*
   *  undeletable (delete resolved to the new collection and no-oped,
   *  orphaning the old vector permanently).
   *
   *  Empty array when nothing exists yet, so callers can short-circuit a
   *  read without creating an empty collection. */
  private async resolveReadCollections(
    userId: string,
    namespace: string,
    projectId: string | null,
  ): Promise<string[]> {
    const primary = this.collectionFor(userId, namespace, projectId);
    const legacy = projectId ? null : this.legacyUserCollectionFor(userId, namespace);
    // Fast path: once both names are known-present we never need to list
    // collections again. (`seenCollections` only ever holds names we have
    // observed to exist.)
    if (this.seenCollections.has(primary) && (!legacy || this.seenCollections.has(legacy))) {
      return legacy ? [primary, legacy] : [primary];
    }
    const existing = await this.client.getCollections();
    const names = new Set(existing.collections.map((c) => c.name));
    const out: string[] = [];
    if (names.has(primary)) {
      this.seenCollections.add(primary);
      out.push(primary);
    }
    if (legacy && names.has(legacy)) {
      this.seenCollections.add(legacy);
      out.push(legacy);
    }
    return out;
  }

  private async ensureCollection(
    userId: string,
    namespace: string,
    projectId: string | null = null,
  ): Promise<void> {
    const name = this.collectionFor(userId, namespace, projectId);
    if (this.seenCollections.has(name)) return;
    const existing = await this.client.getCollections();
    const exists = existing.collections.some((c) => c.name === name);
    if (!exists) {
      try {
        await this.client.createCollection(name, {
          vectors: { size: this.vectorSize, distance: "Cosine" },
        });
      } catch (err) {
        // Concurrent first writes can both observe a missing collection;
        // Qdrant returns 409 to the loser after the winner creates it.
        // At that point the collection exists and this writer can proceed
        // to the upsert. Preserve all other creation failures.
        if (!isCollectionAlreadyExistsError(err)) throw err;
      }
    }
    this.seenCollections.add(name);
  }

  async upsert(args: {
    userId: string;
    projectId?: string | null;
    id: string;
    namespace: string;
    embedding: number[];
    payload: Record<string, unknown>;
  }): Promise<void> {
    const projectId = args.projectId ?? null;
    await this.ensureCollection(args.userId, args.namespace, projectId);
    const point = {
      id: ulidToUuid(args.id),
      vector: args.embedding,
      payload: {
        ...args.payload,
        entryId: args.id,
        userId: args.userId,
        projectId,
      },
    };
    const collection = this.collectionFor(args.userId, args.namespace, projectId);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.client.upsert(collection, { points: [point] });
        return;
      } catch (err) {
        if (attempt >= 8 || !isRetryableQdrantUpsertError(err)) throw err;
        await sleep(Math.min(1000, 50 * 2 ** (attempt - 1)));
      }
    }
  }

  async search(args: {
    userId: string;
    projectId?: string | null;
    namespace: string;
    embedding: number[];
    k: number;
  }): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const projectId = args.projectId ?? null;
    // Reads union the new `novamem_u_…` collection with the legacy
    // unprefixed one (migration for issue #20) so entries written before
    // the rename stay findable after the first post-rename write. When
    // neither exists, return empty rather than creating an empty
    // collection on a pure read path.
    const collections = await this.resolveReadCollections(args.userId, args.namespace, projectId);
    if (collections.length === 0) return [];
    // Uses the Query API rather than the legacy `search()` method.
    //
    // This is not cosmetic. `search()` was removed in
    // @qdrant/js-client-rest 1.19.0, and the production image installs
    // without a lockfile (`npm install --no-package-lock` in the runtime
    // stage), so it resolves the declared range fresh instead of reusing
    // the version the tests pin. With the old `^1.12.0` range that meant
    // tests ran 1.17.0 (where `search()` exists) while the shipped image
    // got 1.19.0 (where it does not) — every vector search in production
    // would have thrown `this.client.search is not a function`, with a
    // fully green test suite.
    //
    // `query()` exists in both, so the call no longer depends on which
    // version resolves. Passing the raw embedding as `query` is a plain
    // nearest-neighbour lookup — `QueryInterface` accepts a `VectorInput`
    // (i.e. `number[]`) directly — exactly what `search({ vector })` did.
    // The response is `{ points }` rather than a bare array.
    const perCollection = await Promise.all(
      collections.map((collection) =>
        this.client
          .query(collection, {
            query: args.embedding,
            limit: args.k,
            with_payload: true,
          })
          .then((r) => r.points),
      ),
    );
    // Merge, keep the best score per entry, and re-apply the caller's k.
    const r = perCollection.flat().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, args.k);
    return r.map((p) => {
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      const id = typeof payload.entryId === "string" ? payload.entryId : String(p.id);
      // Cosine similarity ranges over [-1, 1] but a negative score means
      // "vectors point apart" → semantically unrelated. Clip to 0 so the
      // fuse step's max-normalisation doesn't collapse a near-orthogonal
      // hit's signal contribution to zero across the whole result set
      // (when the only vector hit had score < 0, max.vector was 0 and
      // every entry's vector signal got divided to 0).
      const raw = p.score ?? 0;
      return { id, score: raw > 0 ? raw : 0, payload };
    });
  }


  /** Return which requested warm entry ids still have a vector in Qdrant.
   *  Used by the hygiene report to detect warm rows whose cold vector is
   *  missing. Groups by collection to avoid one Qdrant request per entry. */
  async existingIds(entries: Array<{ id: string; userId: string; projectId: string | null; namespace: string }>): Promise<Set<string>> {
    const out = new Set<string>();
    const groups = new Map<string, Array<{ id: string; userId: string; projectId: string | null; namespace: string }>>();
    for (const e of entries) {
      const collections = await this.resolveReadCollections(e.userId, e.namespace, e.projectId);
      for (const collection of collections) {
        const group = groups.get(collection) ?? [];
        group.push(e);
        groups.set(collection, group);
      }
    }
    for (const [collection, group] of groups) {
      const points = await this.client.retrieve(collection, {
        ids: group.map((e) => ulidToUuid(e.id)),
        with_payload: true,
        with_vector: false,
      });
      for (const p of points) {
        const payload = (p.payload ?? {}) as Record<string, unknown>;
        const entryId = typeof payload.entryId === "string" ? payload.entryId : null;
        if (entryId) out.add(entryId);
      }
    }
    return out;
  }

  async delete(
    userId: string,
    namespace: string,
    id: string,
    projectId: string | null = null,
  ): Promise<void> {
    // Delete from *every* collection that could hold the entry — the new
    // `u_`-prefixed form and the legacy form for entries written before
    // the issue-#20 rename. Deleting from only the preferred collection
    // silently no-oped for legacy entries, leaving their vectors behind
    // forever after the warm row was gone. Qdrant treats deleting an
    // absent point as a no-op, so the extra call is harmless.
    const collections = await this.resolveReadCollections(userId, namespace, projectId);
    if (collections.length === 0) return;
    await Promise.all(
      collections.map((collection) =>
        this.client.delete(collection, { points: [ulidToUuid(id)] }),
      ),
    );
  }

  /** Drop every project-scoped collection for the given project id. Used
   *  when a project is deleted. The naming scheme `novamem_p_<project>_*`
   *  makes this a simple prefix scan. */
  async deleteAllForProject(projectId: string): Promise<string[]> {
    const prefix = `novamem_p_${projectId}_`;
    const all = await this.client.getCollections();
    const mine = all.collections.map((c) => c.name).filter((n) => n.startsWith(prefix));
    const dropped: string[] = [];
    for (const name of mine) {
      try {
        await this.client.deleteCollection(name);
        this.seenCollections.delete(name);
        dropped.push(name);
      } catch (err) {
        // Best-effort: log and continue. Operators previously had no
        // signal when a misconfigured Qdrant returned `dropped: []`.
        // eslint-disable-next-line no-console
        console.warn(
          `[cold-store] deleteCollection(${name}) failed: ${(err as Error).message}`,
        );
      }
    }
    return dropped;
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[cold-store] ping failed: ${(err as Error).message}`);
      return false;
    }
  }
}
