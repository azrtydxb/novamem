/**
 * Unit tests for graph-store input validation.
 *
 * The full GraphStore class wraps a live FalkorDB connection, but the
 * Cypher-param hardening in `validateGraphParams` (issue #44) is pure
 * and worth pinning with a unit test so the allowlist doesn't silently
 * widen during a refactor.
 */
import { describe, expect, it } from "vitest";

import { validateGraphParams } from "./graph-store.js";

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
