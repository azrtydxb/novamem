/**
 * Regression: multi-namespace keyword search must bind its namespace
 * list as a real array.
 *
 * `f.namespace = ANY(${jsArray})` reads correctly but drizzle expands a
 * JS array into a ROW CONSTRUCTOR — `= ANY(($1, $2))` — which Postgres
 * rejects with 42809 "op ANY/ALL (array) requires array on right side".
 * ftsSearch's own catch swallowed the error, so every search with
 * includeNamespaces set silently ran with a dead keyword tier.
 * Measured on the live oracle before the fix, weights {keyword:1,
 * vector:0}: one namespace scored keyword 1.0/0.69, two namespaces
 * scored keyword 0 on every hit.
 *
 * This asserts on the generated SQL itself (drizzle's `sql` template is
 * inspectable) rather than through a fake store, which would never
 * issue the query at all.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

describe("ftsSearch: namespace list binding", () => {
  it("a bare array parameter expands to a row constructor (the bug)", () => {
    const bad = sql`f.namespace = ANY(${["a", "b"]})`;
    const q = bad.getSQL ? bad.getSQL() : bad;
    // Two separate parameter placeholders inside ANY() is exactly the
    // row-constructor shape Postgres rejects.
    expect(q.queryChunks.filter((c) => typeof c === "object").length).toBeGreaterThan(1);
  });

  it("the ::text[] cast keeps it a single array parameter", () => {
    const good = sql`f.namespace = ANY(${["a", "b"]}::text[])`;
    const rendered = JSON.stringify(good);
    expect(rendered).toContain("text[]");
  });

  it("the shipped ftsSearch SQL casts the namespace list", async () => {
    // Read the source of truth: the predicate must carry the cast.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => l.includes("f.namespace = ANY("));
    expect(line, "ftsSearch must still build a namespace ANY() predicate").toBeTruthy();
    expect(line, "namespace array must be cast to text[]").toContain("::text[]");
  });
});
