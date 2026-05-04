import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, effectiveDays, fuse } from "./hybrid-search.js";

describe("hybrid-search.fuse", () => {
  it("normalizes per-signal scores before weighting", () => {
    const out = fuse(
      [
        { id: "a", signals: { keyword: 10 } },
        { id: "a", signals: { vector: 0.8 } },
        { id: "b", signals: { keyword: 5 } },
        { id: "b", signals: { vector: 0.2 } },
        { id: "c", signals: { graph: 0.5 } },
      ],
      DEFAULT_WEIGHTS,
    );
    const a = out.find((r) => r.id === "a")!;
    const b = out.find((r) => r.id === "b")!;
    expect(a.signals.keyword).toBeCloseTo(1.0);
    expect(b.signals.keyword).toBeCloseTo(0.5);
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("returns results sorted by descending score", () => {
    const out = fuse([
      { id: "a", signals: { vector: 0.1 } },
      { id: "b", signals: { vector: 0.9 } },
      { id: "c", signals: { vector: 0.5 } },
    ]);
    expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("drops vector signal when only hits have negative cosine scores (issue #26)", () => {
    // Regression for the cosine-clamp in cold-store.ts: negative cosine
    // scores are clamped to 0 there, NOT divided into the fused score —
    // see the 6-line comment justifying `raw > 0 ? raw : 0`. Construct
    // a result set whose only vector hits have already been clamped
    // (score 0 is what cold-store hands fuse for raw values of -0.1 /
    // -0.2). Vector max stays at 0, so the per-signal norm returns 0
    // for every entry instead of dividing to NaN/Inf and poisoning the
    // entire fused list.
    const out = fuse(
      [
        { id: "a", signals: { vector: 0 } }, // raw -0.1 → clamped to 0
        { id: "b", signals: { vector: 0 } }, // raw -0.2 → clamped to 0
        { id: "c", signals: { keyword: 1.0 } },
      ],
      { keyword: 0.3, vector: 0.6, graph: 0.1 },
    );
    const a = out.find((r) => r.id === "a")!;
    const b = out.find((r) => r.id === "b")!;
    const c = out.find((r) => r.id === "c")!;
    // No NaN / Inf — the bug being prevented is `0 / 0 = NaN` propagating
    // through every entry's score.
    expect(Number.isFinite(a.score)).toBe(true);
    expect(Number.isFinite(b.score)).toBe(true);
    expect(a.signals.vector).toBe(0);
    expect(b.signals.vector).toBe(0);
    // Vector contribution is exactly zero — keyword winner ranks first.
    expect(a.score).toBe(0);
    expect(b.score).toBe(0);
    expect(c.score).toBeGreaterThan(0);
    // Also exercise the not-yet-clamped form (defence-in-depth: fuse
    // itself must not divide-by-zero or NaN-poison if a future caller
    // forgets to clamp).
    const rawNeg = fuse(
      [
        { id: "x", signals: { vector: -0.1 } },
        { id: "y", signals: { vector: -0.2 } },
      ],
      { keyword: 0, vector: 1, graph: 0 },
    );
    for (const r of rawNeg) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.signals.vector).toBe(0);
    }
  });

  it("respects custom weights", () => {
    const keywordHeavy = fuse(
      [
        { id: "a", signals: { keyword: 1, vector: 0 } },
        { id: "b", signals: { keyword: 0, vector: 1 } },
      ],
      { keyword: 1, vector: 0, graph: 0 },
    );
    expect(keywordHeavy[0]!.id).toBe("a");
    const vectorHeavy = fuse(
      [
        { id: "a", signals: { keyword: 1, vector: 0 } },
        { id: "b", signals: { keyword: 0, vector: 1 } },
      ],
      { keyword: 0, vector: 1, graph: 0 },
    );
    expect(vectorHeavy[0]!.id).toBe("b");
  });
});

describe("synaptic-decay.effectiveDays", () => {
  it("matches NovaFlow's pre-extraction formula 7 × log2(hits + 1)", () => {
    expect(effectiveDays(0)).toBeCloseTo(0); // log2(1) = 0
    expect(effectiveDays(1)).toBeCloseTo(7); // log2(2) = 1
    expect(effectiveDays(3)).toBeCloseTo(14); // log2(4) = 2
    expect(effectiveDays(7)).toBeCloseTo(21); // log2(8) = 3
    expect(effectiveDays(15)).toBeCloseTo(28); // log2(16) = 4
  });

  it("frequently accessed memory gets longer effective lifespan", () => {
    expect(effectiveDays(100)).toBeGreaterThan(effectiveDays(10));
    expect(effectiveDays(10)).toBeGreaterThan(effectiveDays(1));
  });
});
