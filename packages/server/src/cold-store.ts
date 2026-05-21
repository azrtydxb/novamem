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
}

export class ColdStore {
  private readonly client: QdrantClient;
  private readonly seenCollections = new Set<string>();
  private readonly vectorSize: number;

  constructor(cfg: ColdStoreConfig) {
    this.client = new QdrantClient({ url: cfg.url });
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

  /** Resolve the collection to read from. Prefers the new `u_` form;
   *  falls back to the legacy form only when the new one doesn't exist
   *  yet AND the legacy one does. Returns null when neither exists, so
   *  callers can short-circuit empty searches without creating an empty
   *  collection. */
  private async resolveReadCollection(
    userId: string,
    namespace: string,
    projectId: string | null,
  ): Promise<string | null> {
    const primary = this.collectionFor(userId, namespace, projectId);
    if (this.seenCollections.has(primary)) return primary;
    const existing = await this.client.getCollections();
    const names = new Set(existing.collections.map((c) => c.name));
    if (names.has(primary)) {
      this.seenCollections.add(primary);
      return primary;
    }
    if (!projectId) {
      const legacy = this.legacyUserCollectionFor(userId, namespace);
      if (names.has(legacy)) {
        this.seenCollections.add(legacy);
        return legacy;
      }
    }
    return null;
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
    // Read-side falls back to the legacy unprefixed user-collection name
    // when the new `novamem_u_…` collection doesn't exist yet (migration
    // for issue #20). When neither exists, return empty rather than
    // creating an empty collection on a pure read path.
    const collection = await this.resolveReadCollection(args.userId, args.namespace, projectId);
    if (!collection) return [];
    const r = await this.client.search(collection, {
      vector: args.embedding,
      limit: args.k,
      with_payload: true,
    });
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
      const collection = await this.resolveReadCollection(e.userId, e.namespace, e.projectId);
      if (!collection) continue;
      const group = groups.get(collection) ?? [];
      group.push(e);
      groups.set(collection, group);
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
    // Resolve to whichever collection actually holds the entry — the new
    // `u_`-prefixed form by default, the legacy form for entries written
    // before the issue-#20 rename. Skip when neither exists (delete is a
    // no-op for never-written entries).
    const collection = await this.resolveReadCollection(userId, namespace, projectId);
    if (!collection) return;
    await this.client.delete(collection, {
      points: [ulidToUuid(id)],
    });
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
