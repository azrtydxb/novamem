/**
 * `force` means "skip the worthiness heuristics", not "skip physics".
 *
 * The length limit used to sit inside the `if (!req.force)` block, so a
 * forced write of a document-sized memory went straight to the embedder.
 * A remote provider answers an over-length input with a 4xx, which is
 * correctly classified non-retryable, so the row was stored, parked with
 * `embedded_at` NULL, and retried by the reconciler forever without ever
 * succeeding — invisible to vector search permanently, with a repair
 * queue that could not drain.
 *
 * Observed for real: a 78k-character LongMemEval chunk (~19.5k tokens)
 * against bge-m3's 8192-token window.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";
import { capInputs, DEFAULT_MAX_INPUT_CHARS } from "../embeddings.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

const HUGE = "a long stretch of conversation. ".repeat(3000); // ~96k chars

describe("over-length content", () => {
  it("is rejected by remember() even under force", async () => {
    const b = quiet(makeEngine());
    const r = await b.engine.remember("u1", { content: HUGE, force: true });
    expect(r.id).toBeNull();
    expect(r.rejected).toMatch(/too long/);
  });

  it("is rejected by capture() even under force", async () => {
    const b = quiet(makeEngine());
    const r = await b.engine.capture("u1", { content: HUGE, force: true });
    expect(r.id).toBeNull();
    expect(r.rejected).toMatch(/too long/);
  });

  it("still accepts ordinary content under force", async () => {
    const b = quiet(makeEngine());
    // Deliberately the kind of short, low-signal line the worthiness gate
    // rejects — `force` must still get it past *that*.
    const r = await b.engine.remember("u1", { content: "ok", force: true });
    expect(r.id).toBeTruthy();
    expect(r.rejected).toBeUndefined();
  });
});

describe("embedder input cap", () => {
  it("truncates rather than letting an over-length input fail unembeddable", () => {
    const { texts, truncated } = capInputs([HUGE, "short"], DEFAULT_MAX_INPUT_CHARS);
    expect(truncated).toBe(1);
    expect(texts[0]!.length).toBe(DEFAULT_MAX_INPUT_CHARS);
    expect(texts[1]).toBe("short");
  });

  it("leaves inputs alone when the cap is disabled", () => {
    const { texts, truncated } = capInputs([HUGE], 0);
    expect(truncated).toBe(0);
    expect(texts[0]!.length).toBe(HUGE.length);
  });
});
