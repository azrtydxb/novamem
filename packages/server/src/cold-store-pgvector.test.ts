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
  it("user-scoped search filters on the u:<user> partition scope + namespace", async () => {
    const { store, calls } = mocked();
    await store.search({ userId: "u1", namespace: "ns", embedding: [1, 0, 0, 0], k: 5 });
    const q = calls.find((c) => c.text.includes("ORDER BY embedding"));
    expect(q).toBeTruthy();
    expect(q!.text).toContain("scope = $1");
    expect(q!.values).toEqual(["u:u1", "[1,0,0,0]", "ns", 5]);
  });

  it("project-scoped search filters on the p:<project> partition scope (members share it)", async () => {
    const { store, calls } = mocked();
    await store.search({ userId: "u1", projectId: "p9", namespace: "ns", embedding: [0, 1, 0, 0], k: 3 });
    const q = calls.find((c) => c.text.includes("ORDER BY embedding"));
    expect(q!.text).toContain("scope = $1");
    expect(q!.values![0]).toBe("p:p9");
  });

  it("delete carries the FULL scope filter — user, project, and namespace", async () => {
    const { store, calls } = mocked();
    await store.delete("u1", "ns", "01ENTRY", null);
    const q = calls.find((c) => c.text.startsWith("DELETE"));
    expect(q!.text).toContain("scope = $1");
    expect(q!.text).toContain("namespace = $3");
    expect(q!.values).toEqual(["u:u1", "01ENTRY", "ns"]);
  });

  it("existingIds joins on scope+namespace, not bare ids", async () => {
    const { store, calls } = mocked();
    await store.existingIds([
      { id: "01A", userId: "u1", projectId: null, namespace: "ns1" },
      { id: "01B", userId: "u2", projectId: "p1", namespace: "ns2" },
    ]);
    const q = calls.find((c) => c.text.includes("AS v(id"));
    expect(q).toBeTruthy();
    expect(q!.text).toContain("t.scope = v.scope");
    expect(q!.text).toContain("t.namespace = v.namespace");
    expect(q!.values).toEqual(["01A", "u:u1", "ns1", "01B", "p:p1", "ns2"]);
  });

  it("upsert stores the entryId/userId/projectId echo in the payload like Qdrant", async () => {
    const { store, calls } = mocked();
    await store.upsert({
      userId: "u1", id: "01E", namespace: "ns",
      embedding: [0, 0, 1, 0], payload: { source: "manual" },
    });
    const q = calls.find((c) => c.text.startsWith("INSERT INTO"));
    const payload = q!.values![6] as Record<string, unknown>;
    expect(payload).toMatchObject({ source: "manual", entryId: "01E", userId: "u1", projectId: null });
  });

  it("retries ensureReady after a failed first attempt (no sticky rejection)", async () => {
    const store = new PgVectorColdStore({ url: "postgres://unused", vectorSize: 4 });
    let attempt = 0;
    const fake = {
      query: async (text: string) => {
        if (text.includes("CREATE EXTENSION") && ++attempt === 1) {
          throw new Error("db briefly down");
        }
        if (text.includes("atttypmod")) return { rows: [{ dim: 4 }] };
        if (text.includes("indisprimary")) return { rows: [{ cols: ["entry_id", "scope", "namespace"] }] };
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({ query: fake.query, release: () => {} }),
      end: async () => {},
    };
    (store as unknown as { pool: typeof fake }).pool = fake;
    expect(await store.ping()).toBe(false); // first attempt fails
    expect(await store.ping()).toBe(true);  // second attempt retries and succeeds
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
