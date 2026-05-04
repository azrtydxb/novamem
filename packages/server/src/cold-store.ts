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
   *  - User-wide entries (no project): `novamem_<user>_<namespace>`
   *  - Project-scoped entries: `novamem_p_<project>_<namespace>`
   *
   *  Project names lead with `p_` so a user id could never collide with
   *  a project id (user ids are slugs without that prefix by convention).
   *  Project membership is cross-user by design, so the user id
   *  intentionally does not appear in project-scoped collection names. */
  private collectionFor(userId: string, namespace: string, projectId: string | null = null): string {
    if (projectId) return `novamem_p_${projectId}_${namespace}`;
    return `novamem_${userId}_${namespace}`;
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
      await this.client.createCollection(name, {
        vectors: { size: this.vectorSize, distance: "Cosine" },
      });
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
    await this.client.upsert(this.collectionFor(args.userId, args.namespace, projectId), {
      points: [
        {
          id: ulidToUuid(args.id),
          vector: args.embedding,
          payload: {
            ...args.payload,
            entryId: args.id,
            userId: args.userId,
            projectId,
          },
        },
      ],
    });
  }

  async search(args: {
    userId: string;
    projectId?: string | null;
    namespace: string;
    embedding: number[];
    k: number;
  }): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const projectId = args.projectId ?? null;
    await this.ensureCollection(args.userId, args.namespace, projectId);
    const r = await this.client.search(this.collectionFor(args.userId, args.namespace, projectId), {
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

  async delete(
    userId: string,
    namespace: string,
    id: string,
    projectId: string | null = null,
  ): Promise<void> {
    await this.ensureCollection(userId, namespace, projectId);
    await this.client.delete(this.collectionFor(userId, namespace, projectId), {
      points: [ulidToUuid(id)],
    });
  }

  /** Drop every collection belonging to the given user. Used when a
   *  user is deleted — leaves the qdrant cluster clean of orphaned
   *  vector data. Returns the names of the dropped collections so callers
   *  can log + audit. Best-effort: a delete failure for one collection
   *  doesn't block the others. */
  async deleteAllForUser(userId: string): Promise<string[]> {
    const prefix = `novamem_${userId}_`;
    const all = await this.client.getCollections();
    const mine = all.collections.map((c) => c.name).filter((n) => n.startsWith(prefix));
    const dropped: string[] = [];
    for (const name of mine) {
      try {
        await this.client.deleteCollection(name);
        this.seenCollections.delete(name);
        dropped.push(name);
      } catch {
        // Swallow — caller will see the missing entries in the next listing.
      }
    }
    return dropped;
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
      } catch {
        // ignore
      }
    }
    return dropped;
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }
}
