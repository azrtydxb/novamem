/**
 * Repro for the cross-namespace leak in the dedup fast-path.
 *
 * `findByContentHash` is keyed on (user_id, project_id, content_hash) —
 * namespace is deliberately NOT part of that key, so writing the same
 * text to a second namespace returns the first entry's id. That part is
 * by design.
 *
 * The bug is what `backfillMissingVector` then does with it: it is handed
 * the *request's* namespace rather than the namespace the existing entry
 * actually lives in, so it indexes that entry's vector under the caller's
 * namespace. The entry becomes vector-searchable from a shelf it was
 * never written to.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";

/** Silence the expected WARN logs so a passing run stays readable. */
function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

describe("dedup fast-path namespace scoping", () => {
  it("does not make an entry searchable from a namespace it was never written to", async () => {
    const b = quiet(makeEngine());

    const first = await b.engine.remember("u1", {
      content: "the deploy target is 192.168.10.121",
      namespace: "alpha",
      force: true,
    });
    expect(first.id).toBeTruthy();

    // Same content, different shelf. Dedup returns alpha's id (by design).
    const second = await b.engine.remember("u1", {
      content: "the deploy target is 192.168.10.121",
      namespace: "beta",
      force: true,
    });
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);

    // The entry belongs to `alpha`. Searching `beta` must not surface it.
    const inBeta = await b.engine.search("u1", {
      query: "deploy target",
      namespace: "beta",
      k: 10,
    });
    expect(inBeta.results.map((r) => r.id)).not.toContain(first.id);

    // ...and it must still be findable where it actually lives.
    const inAlpha = await b.engine.search("u1", {
      query: "deploy target",
      namespace: "alpha",
      k: 10,
    });
    expect(inAlpha.results.map((r) => r.id)).toContain(first.id);
  });
});
