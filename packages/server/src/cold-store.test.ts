import { beforeEach, describe, expect, it, vi } from "vitest";

const qdrant = vi.hoisted(() => ({
  collections: new Set<string>(),
  getCollections: vi.fn(async () => ({
    collections: Array.from(qdrant.collections).map((name) => ({ name })),
  })),
  createCollection: vi.fn(async (name: string) => {
    if (qdrant.collections.has(name)) {
      const err = new Error("Conflict: Collection already exists") as Error & { status?: number; statusCode?: number };
      err.status = 409;
      err.statusCode = 409;
      throw err;
    }
    qdrant.collections.add(name);
  }),
  upsert: vi.fn(async () => ({})),
  search: vi.fn(async () => []),
  retrieve: vi.fn(async () => []),
  delete: vi.fn(async () => ({})),
  deleteCollection: vi.fn(async (name: string) => {
    qdrant.collections.delete(name);
  }),
}));

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn(() => qdrant),
}));

const { ColdStore } = await import("./cold-store.js");

describe("ColdStore", () => {
  beforeEach(() => {
    qdrant.collections.clear();
    qdrant.getCollections.mockClear();
    qdrant.createCollection.mockClear();
    qdrant.upsert.mockClear();
    qdrant.search.mockClear();
    qdrant.retrieve.mockClear();
    qdrant.delete.mockClear();
    qdrant.deleteCollection.mockClear();
  });

  it("treats a concurrent Qdrant collection-already-exists conflict as successful creation", async () => {
    const store = new ColdStore({ url: "http://qdrant.test", vectorSize: 3 });

    await expect(
      Promise.all([
        store.upsert({
          userId: "user-1",
          namespace: "fresh-namespace",
          id: "entry-1",
          embedding: [1, 0, 0],
          payload: { text: "first" },
        }),
        store.upsert({
          userId: "user-1",
          namespace: "fresh-namespace",
          id: "entry-2",
          embedding: [0, 1, 0],
          payload: { text: "second" },
        }),
      ]),
    ).resolves.toBeDefined();

    expect(qdrant.createCollection).toHaveBeenCalledTimes(2);
    expect(qdrant.upsert).toHaveBeenCalledTimes(2);
  });

  it("retries Qdrant upserts when a replicated collection asks the client to retry", async () => {
    const store = new ColdStore({ url: "http://qdrant.test", vectorSize: 3 });
    const retryable = new Error("Internal Server Error") as Error & {
      status?: number;
      data?: { status?: { error?: string } };
    };
    retryable.status = 500;
    retryable.data = {
      status: {
        error:
          "Service internal error: Failed to apply operation to at least one `Active` replica. Consistency of this update is not guaranteed. Please retry.",
      },
    };
    qdrant.upsert
      .mockRejectedValueOnce(retryable)
      .mockRejectedValueOnce(retryable)
      .mockRejectedValueOnce(retryable)
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce({});

    await expect(
      store.upsert({
        userId: "user-1",
        namespace: "fresh-namespace",
        id: "entry-1",
        embedding: [1, 0, 0],
        payload: { text: "first" },
      }),
    ).resolves.toBeUndefined();

    expect(qdrant.upsert).toHaveBeenCalledTimes(5);
  });
});
