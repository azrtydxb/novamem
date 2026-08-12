/**
 * PgVectorColdStore unit tests — SQL-shape tests against a captured
 * mock pool, because the one property Qdrant gave structurally
 * (per-tenant collections) is here a WHERE-clause discipline: every
 * read and delete must carry the full scope filter. Integration
 * behaviour (recall, iterative scans) is the LoCoMo/quick-gate
 * parity gate's job, not vitest's.
 */
import { describe, expect, it } from "vitest";

import { PgVectorColdStore } from "./cold-store-pgvector.js";

type Call = { text: string; values?: unknown[] };

function mocked() {
  const calls: Call[] = [];
  const store = new PgVectorColdStore({ url: "postgres://unused", vectorSize: 4 });
  const fake = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes("atttypmod")) return { rows: [{ dim: 4 }] };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: fake.query,
      release: () => {},
    }),
    end: async () => {},
  };
  (store as unknown as { pool: typeof fake }).pool = fake;
  return { store, calls };
}

describe("pgvector cold store: scope discipline", () => {
  it("user-scoped search filters on user_id AND project_id IS NULL AND namespace", async () => {
    const { store, calls } = mocked();
    await store.search({ userId: "u1", namespace: "ns", embedding: [1, 0, 0, 0], k: 5 });
    const q = calls.find((c) => c.text.includes("ORDER BY embedding"));
    expect(q).toBeTruthy();
    expect(q!.text).toContain("user_id = $1");
    expect(q!.text).toContain("project_id IS NULL");
    expect(q!.text).toContain("namespace = $3");
    expect(q!.values).toEqual(["u1", "[1,0,0,0]", "ns", 5]);
  });

  it("project-scoped search filters on project_id (project members share the space)", async () => {
    const { store, calls } = mocked();
    await store.search({ userId: "u1", projectId: "p9", namespace: "ns", embedding: [0, 1, 0, 0], k: 3 });
    const q = calls.find((c) => c.text.includes("ORDER BY embedding"));
    expect(q!.text).toContain("project_id = $1");
    expect(q!.values![0]).toBe("p9");
  });

  it("delete carries the scope filter, not just the id", async () => {
    const { store, calls } = mocked();
    await store.delete("u1", "ns", "01ENTRY", null);
    const q = calls.find((c) => c.text.startsWith("DELETE"));
    expect(q!.text).toContain("user_id = $1");
    expect(q!.text).toContain("project_id IS NULL");
    expect(q!.values).toEqual(["u1", "01ENTRY"]);
  });

  it("upsert stores the entryId/userId/projectId echo in the payload like Qdrant", async () => {
    const { store, calls } = mocked();
    await store.upsert({
      userId: "u1", id: "01E", namespace: "ns",
      embedding: [0, 0, 1, 0], payload: { source: "manual" },
    });
    const q = calls.find((c) => c.text.startsWith("INSERT INTO"));
    const payload = q!.values![5] as Record<string, unknown>;
    expect(payload).toMatchObject({ source: "manual", entryId: "01E", userId: "u1", projectId: null });
  });

  it("refuses a dimensionality mismatch loudly", async () => {
    const calls: Call[] = [];
    const store = new PgVectorColdStore({ url: "postgres://unused", vectorSize: 8 });
    const fake = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("atttypmod")) return { rows: [{ dim: 4 }] }; // existing table is vector(4)
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({ query: fake.query, release: () => {} }),
      end: async () => {},
    };
    (store as unknown as { pool: typeof fake }).pool = fake;
    await expect(store.ping()).resolves.toBe(false); // ensureReady throws inside
    await expect(
      store.search({ userId: "u", namespace: "n", embedding: [1, 0, 0, 0, 0, 0, 0, 0], k: 1 }),
    ).rejects.toThrow(/vector\(4\)/);
  });
});
