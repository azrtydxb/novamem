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

  private collectionFor(namespace: string): string {
    return `novamem_${namespace}`;
  }

  private async ensureCollection(namespace: string): Promise<void> {
    const name = this.collectionFor(namespace);
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
    id: string;
    namespace: string;
    embedding: number[];
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.ensureCollection(args.namespace);
    await this.client.upsert(this.collectionFor(args.namespace), {
      points: [
        {
          id: ulidToUuid(args.id),
          vector: args.embedding,
          payload: { ...args.payload, entryId: args.id },
        },
      ],
    });
  }

  async search(args: {
    namespace: string;
    embedding: number[];
    k: number;
  }): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    await this.ensureCollection(args.namespace);
    const r = await this.client.search(this.collectionFor(args.namespace), {
      vector: args.embedding,
      limit: args.k,
      with_payload: true,
    });
    return r.map((p) => {
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      // Prefer the ULID stashed in payload; fall back to the raw qdrant id.
      const id = typeof payload.entryId === "string" ? payload.entryId : String(p.id);
      return { id, score: p.score ?? 0, payload };
    });
  }

  async delete(namespace: string, id: string): Promise<void> {
    await this.ensureCollection(namespace);
    await this.client.delete(this.collectionFor(namespace), { points: [ulidToUuid(id)] });
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
