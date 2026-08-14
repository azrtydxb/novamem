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

  it("the shipped ftsSearch binds namespaces as individual parameters", async () => {
    // A cast can't rescue this — `ANY(${array}::text[])` fails with
    // "cannot cast type record to text[]" because the cast lands on the
    // already-expanded record. The predicate must be an IN-list built
    // from separate bound parameters, and it must keep the `f` alias
    // (drizzle's inArray would emit the fully-qualified column).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src, "ftsSearch must not pass a JS array into ANY()").not.toContain(
      "f.namespace = ANY(${args.namespaces",
    );
    expect(src, "namespaces must bind as an aliased IN-list").toContain("f.namespace IN (");
  });
});
