/**
 * The updation path asks an LLM whether a new fact supersedes an existing
 * one. It used to ask about whatever `cold.search` returned, and cosine
 * always returns k neighbours whether or not anything is related — the
 * same property `DEFAULT_MIN_VECTOR_SCORE` exists to defend search
 * against. So once a namespace held any facts, the LLM was consulted for
 * essentially every extracted fact: ~6 LLM round-trips per chunk, and
 * capture measured ~11x slower per chunk than remember.
 *
 * Measured on a seeded namespace, a fact's cosine to its nearest *other*
 * fact runs p50 0.798 / p90 0.876 — most pairs are same-topic, not
 * restatements. Only a near-restatement can be an UPDATE target.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

/** Records how often the LLM decision was asked for. */
function stubExtractor(decisions: { calls: number }) {
  return {
    async extract() {
      return [
        {
          type: "preference",
          subject: "the user",
          predicate: "prefers",
          object: "oat milk in coffee",
          entities: [],
          importance: 3,
        },
      ];
    },
    async decideOperation() {
      decisions.calls += 1;
      return { op: "ADD" as const };
    },
  };
}

/** Force the similarity lookup to report one neighbour at `score`. */
async function runWithNeighbourScore(score: number): Promise<number> {
  const decisions = { calls: 0 };
  const b = quiet(makeEngine({ extractor: stubExtractor(decisions) }));

  // A stored *fact* row for the neighbour to resolve to — the updation
  // path ignores anything whose sourceType isn't "fact".
  const neighbourId = await b.warm.insertEntry({
    userId: "u1",
    projectId: null,
    content: "[preference] the user prefers soy milk in coffee",
    namespace: "default",
    source: "manual",
    agentName: null,
    metadata: { fact: { type: "preference", importance: 3 } },
    sourceType: "fact",
    capturedFrom: null,
    contentHash: "neighbour-hash",
  });

  b.cold.search = async () => [{ id: neighbourId, score, payload: {} }];

  await b.engine.remember("u1", { content: "a chunk mentioning coffee preferences", force: true });
  // Extraction is fire-and-forget, so wait on the side effect rather than
  // a fixed delay: poll until the extracted fact row appears. A sleep long
  // enough to be safe on a loaded runner would slow every run, and one
  // short enough to be quick would flake.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const stored = [...b.warm.rows.values()].some(
      (r) => r.sourceType === "fact" && r.content.includes("oat milk"),
    );
    if (stored) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return decisions.calls;
}

describe("fact updation similarity floor", () => {
  it("does not consult the LLM about a merely same-topic neighbour", async () => {
    // 0.80 is around the median fact-to-fact cosine — same subject, not a
    // restatement, and both facts deserve to be kept.
    expect(await runWithNeighbourScore(0.8)).toBe(0);
  });

  it("still consults the LLM about a near-restatement", async () => {
    expect(await runWithNeighbourScore(0.95)).toBe(1);
  });

  it("treats the threshold as inclusive", async () => {
    expect(await runWithNeighbourScore(0.85)).toBe(1);
  });
});
