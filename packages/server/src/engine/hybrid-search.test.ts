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
