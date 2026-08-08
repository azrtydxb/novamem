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
  // The Query API, not the legacy `search()` — which no longer exists in
  // @qdrant/js-client-rest >= 1.19.0. Deliberately NOT mocking `search`
  // here: if ColdStore ever reaches for it again, these tests fail with
  // "not a function" instead of silently passing against a method the
  // shipped client doesn't have.
  query: vi.fn(async () => ({ points: [] as Array<Record<string, unknown>> })),
  retrieve: vi.fn(async () => []),
  delete: vi.fn(async () => ({})),
  deleteCollection: vi.fn(async (name: string) => {
    qdrant.collections.delete(name);
  }),
}));

vi.mock("@qdrant/js-client-rest", () => ({
  // A function EXPRESSION, not an arrow: ColdStore calls `new QdrantClient(...)`,
  // and arrow functions are not constructable in JavaScript. vitest 3 happened
  // to tolerate it; vitest 4 calls the factory result directly and it fails with
  // "is not a constructor".
  QdrantClient: vi.fn(function () {
    return qdrant;
  }),
}));

const { ColdStore } = await import("./cold-store.js");

describe("ColdStore", () => {
  beforeEach(() => {
    qdrant.collections.clear();
    qdrant.getCollections.mockClear();
    qdrant.createCollection.mockClear();
    qdrant.upsert.mockClear();
    qdrant.query.mockClear();
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

  it("searches via the Query API and unwraps `points`", async () => {
    // Regression for the version-drift bug: the runtime image resolves
    // the qdrant client fresh, so ColdStore must call a method that
    // exists across the supported range. `query()` does; `search()` was
    // removed in 1.19.0.
    const store = new ColdStore({ url: "http://qdrant.test", vectorSize: 3 });
    qdrant.collections.add("novamem_u_user-1_default");
    qdrant.query.mockResolvedValueOnce({
      points: [
        { id: "uuid-a", score: 0.91, payload: { entryId: "entry-a" } },
        { id: "uuid-b", score: 0.42, payload: { entryId: "entry-b" } },
      ],
    });

    const hits = await store.search({
      userId: "user-1",
      namespace: "default",
      embedding: [1, 0, 0],
      k: 5,
    });

    expect(qdrant.query).toHaveBeenCalledTimes(1);
    const [collection, body] = qdrant.query.mock.calls[0]!;
    expect(collection).toBe("novamem_u_user-1_default");
    // Raw vector as `query` == nearest-neighbour, the old search({vector}).
    expect(body).toMatchObject({ query: [1, 0, 0], limit: 5, with_payload: true });
    expect(hits.map((h) => h.id)).toEqual(["entry-a", "entry-b"]);
    expect(hits[0]!.score).toBeCloseTo(0.91);
  });

  it("deduplicates an entry present in BOTH the primary and legacy collections", async () => {
    // Mid-migration an entry can have a vector in both collections: a
    // re-upsert writes to the primary while the legacy copy remains.
    // Without dedup that entry occupies two of the k slots and pushes a
    // genuinely different memory out of the results.
    const store = new ColdStore({ url: "http://qdrant.test", vectorSize: 3 });
    qdrant.collections.add("novamem_u_user-1_default");
    qdrant.collections.add("novamem_user-1_default"); // legacy name
    qdrant.query
      .mockResolvedValueOnce({
        points: [{ id: "uuid-a", score: 0.9, payload: { entryId: "entry-a" } }],
      })
      .mockResolvedValueOnce({
        points: [
          { id: "uuid-a", score: 0.5, payload: { entryId: "entry-a" } }, // same entry, stale copy
          { id: "uuid-b", score: 0.4, payload: { entryId: "entry-b" } },
        ],
      });

    const hits = await store.search({
      userId: "user-1",
      namespace: "default",
      embedding: [1, 0, 0],
      k: 2,
    });

    expect(qdrant.query).toHaveBeenCalledTimes(2);
    // entry-a appears once, at its BEST score, and entry-b still makes
    // the cut rather than being crowded out by the duplicate.
    expect(hits.map((h) => h.id)).toEqual(["entry-a", "entry-b"]);
    expect(hits[0]!.score).toBeCloseTo(0.9);
  });

  it("clamps negative cosine scores to zero", async () => {
    const store = new ColdStore({ url: "http://qdrant.test", vectorSize: 3 });
    qdrant.collections.add("novamem_u_user-1_default");
    qdrant.query.mockResolvedValueOnce({
      points: [{ id: "uuid-a", score: -0.2, payload: { entryId: "entry-a" } }],
    });

    const hits = await store.search({
      userId: "user-1",
      namespace: "default",
      embedding: [1, 0, 0],
      k: 5,
    });
    expect(hits[0]!.score).toBe(0);
  });
});
