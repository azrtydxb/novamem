/**
 * Unit tests for graph-store input validation.
 *
 * The full GraphStore class wraps a live FalkorDB connection, but the
 * Cypher-param hardening in `validateGraphParams` (issue #44) is pure
 * and worth pinning with a unit test so the allowlist doesn't silently
 * widen during a refactor.
 *
 * `ensureSchema` is also tested here. It runs three `CREATE INDEX`
 * statements on connect and must be idempotent (FalkorDB throws on
 * duplicate index creates and we deliberately swallow those errors so
 * connect() is safe on every pod restart).
 */
import { describe, expect, it, vi } from "vitest";

import { GraphStore, validateGraphParams } from "./graph-store.js";

describe("validateGraphParams (issue #44)", () => {
  it("accepts the allowlisted depths {1, 2, 3}", () => {
    for (const depth of [1, 2, 3]) {
      expect(() => validateGraphParams(depth, 20)).not.toThrow();
    }
  });

  it("rejects depths outside the allowlist", () => {
    for (const depth of [0, 4, 5, 10, -1, 1.5]) {
      expect(() => validateGraphParams(depth, 20)).toThrow(
        /invalid graph traversal params/,
      );
    }
  });

  it("rejects NaN depth", () => {
    expect(() => validateGraphParams(Number.NaN, 20)).toThrow(
      /invalid graph traversal params/,
    );
  });

  it("rejects non-finite depth", () => {
    expect(() => validateGraphParams(Number.POSITIVE_INFINITY, 20)).toThrow(
      /invalid graph traversal params/,
    );
    expect(() => validateGraphParams(Number.NEGATIVE_INFINITY, 20)).toThrow(
      /invalid graph traversal params/,
    );
  });

  it("rejects non-numeric depth (e.g. string from a malformed body)", () => {
    expect(() => validateGraphParams("1" as unknown as number, 20)).toThrow(
      /invalid graph traversal params/,
    );
  });

  it("rejects NaN / non-finite limit", () => {
    expect(() => validateGraphParams(1, Number.NaN)).toThrow(
      /invalid graph traversal params/,
    );
    expect(() => validateGraphParams(1, Number.POSITIVE_INFINITY)).toThrow(
      /invalid graph traversal params/,
    );
  });

  it("rejects non-numeric limit", () => {
    expect(() => validateGraphParams(1, "20" as unknown as number)).toThrow(
      /invalid graph traversal params/,
    );
  });

  it("accepts large but finite limits — caller clamps to 1..200 afterwards", () => {
    // The validator only asserts finiteness on `limit`; the numeric
    // clamp downstream caps it at 200. This test pins that contract so
    // a future "tighten the validator" refactor doesn't break the
    // clamp-only-after-finiteness assumption documented inline.
    expect(() => validateGraphParams(1, 9999)).not.toThrow();
  });
});

/** Helpers for ensureSchema tests — we drive the private method by
 *  monkey-patching the `graph` field directly. The real FalkorDB driver
 *  is not loaded; we only care about the order/content of the Cypher
 *  statements and how the catch-clauses behave. */
type FakeGraph = { query: (stmt: string) => Promise<unknown> };

function makeStoreWithFakeGraph(graph: FakeGraph): {
  store: GraphStore;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const store = new GraphStore({ url: "redis://test", logger: { warn } });
  // Inject the fake graph via the existing private field. This is the
  // smallest surface we can target without a real FalkorDB.
  (store as unknown as { graph: FakeGraph }).graph = graph;
  return { store, warn };
}

describe("GraphStore.ensureSchema", () => {
  it("issues three CREATE INDEX statements covering id, user, project", async () => {
    const calls: string[] = [];
    const graph: FakeGraph = {
      query: async (stmt: string) => {
        calls.push(stmt);
        return { data: [] };
      },
    };
    const { store, warn } = makeStoreWithFakeGraph(graph);
    await (store as unknown as { ensureSchema(): Promise<void> }).ensureSchema();

    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("CREATE INDEX FOR (n:Memory) ON (n.id)");
    expect(calls[1]).toContain("CREATE INDEX FOR (n:Memory) ON (n.user)");
    expect(calls[2]).toContain("CREATE INDEX FOR (n:Memory) ON (n.project)");
    expect(warn).not.toHaveBeenCalled();
  });

  it("is idempotent — swallows duplicate-index errors silently", async () => {
    // FalkorDB returns errors like "Index already indexed" or
    // "Attribute 'id' is already indexed". Both must NOT log a warning
    // because they fire on every restart after the first.
    const messages = [
      "Index already indexed",
      "Attribute 'user' is already indexed for label Memory",
      "Index already exists",
    ];
    let i = 0;
    const graph: FakeGraph = {
      query: async () => {
        const msg = messages[i++] ?? "Index already exists";
        throw new Error(msg);
      },
    };
    const { store, warn } = makeStoreWithFakeGraph(graph);
    await (store as unknown as { ensureSchema(): Promise<void> }).ensureSchema();

    expect(warn).not.toHaveBeenCalled();
  });

  it("logs (but does not throw) on unexpected errors", async () => {
    // Anything that isn't a duplicate-index error should surface as a
    // warning so operators can see schema regressions, but it must not
    // fail the connect() call.
    const graph: FakeGraph = {
      query: async () => {
        throw new Error("connection reset by peer");
      },
    };
    const { store, warn } = makeStoreWithFakeGraph(graph);
    await expect(
      (store as unknown as { ensureSchema(): Promise<void> }).ensureSchema(),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(3); // one per failed statement
    const firstCallArg = (warn.mock.calls[0]?.[0] ?? {}) as {
      stmt?: string;
      err?: string;
    };
    expect(firstCallArg.stmt).toContain("CREATE INDEX FOR (n:Memory)");
    expect(firstCallArg.err).toBe("connection reset by peer");
  });

  it("is a no-op when graph is null (disconnected)", async () => {
    const store = new GraphStore({ url: "redis://test" });
    // Don't inject a graph — internal field stays null.
    await expect(
      (store as unknown as { ensureSchema(): Promise<void> }).ensureSchema(),
    ).resolves.toBeUndefined();
  });
});
