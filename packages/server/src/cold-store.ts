/**
 * Cold store — Qdrant-backed vector index. One collection per namespace,
 * created lazily on first write.
 */

import { QdrantClient } from "@qdrant/js-client-rest";

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
      points: [{ id: args.id, vector: args.embedding, payload: args.payload }],
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
    return r.map((p) => ({
      id: String(p.id),
      score: p.score ?? 0,
      payload: (p.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async delete(namespace: string, id: string): Promise<void> {
    await this.ensureCollection(namespace);
    await this.client.delete(this.collectionFor(namespace), { points: [id] });
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
