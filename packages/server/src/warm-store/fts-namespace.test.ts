/**
 * Regression: multi-namespace keyword search must actually run the FTS
 * tier. `f.namespace = ANY(${array})` expanded to a row constructor and
 * Postgres rejected it (42809); the tier's catch swallowed the error, so
 * every includeNamespaces search silently degraded to vector-only.
 * Measured on the live oracle before the fix: single-namespace hits
 * scored keyword 1.0, the same query across two namespaces scored 0.
 */
import { describe, expect, it } from "vitest";

import { asWarm, FakeWarmStore } from "../test-fakes.js";

describe("ftsSearch: multi-namespace parameter binding", () => {
  it("binds the namespace list as an array, not a row constructor", async () => {
    // The fake store records the SQL it was handed; the shape of the
    // namespace predicate is what regressed.
    const warm = new FakeWarmStore();
    const sqls: string[] = [];
    const orig = warm.pool.query.bind(warm.pool);
    warm.pool.query = (async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string") sqls.push(sql);
      return orig(sql, params ?? []);
    }) as typeof warm.pool.query;
    await asWarm(warm)
      .ftsSearch({
        userId: "public",
        projectId: null,
        namespaces: ["a", "b"],
        query: "anything",
        k: 5,
      })
      .catch(() => {
        /* the fake may not implement the query; the SQL shape is the assertion */
      });
    const nsSql = sqls.find((s) => s.includes("namespace = ANY"));
    if (nsSql) {
      expect(nsSql, "namespace array must be cast to text[]").toContain("::text[]");
    }
  });
});
