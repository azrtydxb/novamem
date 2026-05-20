import { describe, expect, it } from "vitest";

import {
  adaptBeirFixture,
  adaptLoCoMoFixture,
  adaptLongContextFixture,
  adaptLongMemEvalFixture,
  adaptNovaMemFixture,
  adaptRagFixture,
} from "../src/adapters.js";
import { benchmarkFixtureSchema } from "../src/schema.js";

describe("benchmark adapters", () => {
  it("adapts LongMemEval-style multi-session memory questions", () => {
    const fixture = adaptLongMemEvalFixture({
      dataset: "longmemeval-mini",
      conversations: [
        {
          session_id: "s1",
          date: "2026-05-01",
          turns: [
            { role: "user", content: "My reef tank uses ReefMat 1200 fleece." },
            { role: "assistant", content: "Noted." },
          ],
        },
      ],
      questions: [
        {
          question_id: "q1",
          question: "Which fleece roller does the reef tank use?",
          answer: "ReefMat 1200",
          evidence_session_ids: ["s1"],
        },
      ],
    });

    expect(fixture.kind).toBe("longmemeval");
    expect(fixture.memories).toHaveLength(1);
    expect(fixture.queries[0]).toMatchObject({ queryId: "q1", expectedAnswer: "ReefMat 1200" });
    expect(fixture.queries[0]?.relevantMemoryIds).toEqual(["longmemeval-mini:s1"]);
    expect(() => benchmarkFixtureSchema.parse(fixture)).not.toThrow();
  });

  it("adapts LoCoMo-style speaker conversations and evidence ids", () => {
    const fixture = adaptLoCoMoFixture({
      conversation_id: "dialog-1",
      sessions: [
        { session_id: "m1", speaker: "Pascal", text: "Audrey prefers gentle bedtime stories." },
      ],
      qa: [
        { id: "q1", question: "What kind of bedtime stories does Audrey prefer?", answer: "gentle", evidence: ["m1"] },
      ],
    });

    expect(fixture.kind).toBe("locomo");
    expect(fixture.memories[0]?.metadata?.speaker).toBe("Pascal");
    expect(fixture.queries[0]?.relevantMemoryIds).toEqual(["dialog-1:m1"]);
    expect(() => benchmarkFixtureSchema.parse(fixture)).not.toThrow();
  });

  it("adapts BEIR/RAG corpora with qrels into retrieval-only cases", () => {
    const fixture = adaptBeirFixture({
      name: "beir-mini",
      corpus: { d1: { title: "NovaMem", text: "Hybrid search uses keyword vector graph fusion." } },
      queries: { q1: "What search fusion does NovaMem use?" },
      qrels: { q1: { d1: 1 } },
    });

    expect(fixture.kind).toBe("beir");
    expect(fixture.memories[0]?.id).toBe("d1");
    expect(fixture.queries[0]?.relevantMemoryIds).toEqual(["d1"]);
    expect(() => benchmarkFixtureSchema.parse(fixture)).not.toThrow();
  });

  it("adapts RAG QA corpora with evidence documents", () => {
    const fixture = adaptRagFixture({
      name: "rag-mini",
      documents: [{ id: "doc-1", text: "NovaMem uses memory_context before substantive work." }],
      questions: [{ id: "q1", question: "What should run before substantive work?", answer: "memory_context", evidence: ["doc-1"] }],
    });

    expect(fixture.kind).toBe("rag");
    expect(fixture.queries[0]?.expectedAnswer).toBe("memory_context");
    expect(fixture.queries[0]?.relevantMemoryIds).toEqual(["doc-1"]);
    expect(() => benchmarkFixtureSchema.parse(fixture)).not.toThrow();
  });

  it("adapts long-context needle cases and NovaMem-specific cases", () => {
    const longContext = adaptLongContextFixture({
      name: "ruler-mini",
      haystack: ["noise", "Needle: project port is 7778", "more noise"],
      questions: [{ id: "q1", question: "What is the project port?", answer: "7778", evidence_indexes: [1] }],
    });
    const novamem = adaptNovaMemFixture({
      name: "novamem-specific",
      memories: [{ id: "old", text: "Timezone is Belgium", supersededBy: "new" }, { id: "new", text: "Timezone is Asia/Dubai" }],
      queries: [{ id: "q1", text: "What is the timezone?", answer: "Asia/Dubai", relevant: ["new"], forbidden: ["old"] }],
    });

    expect(longContext.kind).toBe("long-context");
    expect(longContext.queries[0]?.relevantMemoryIds).toEqual(["ruler-mini:needle:1"]);
    expect(novamem.kind).toBe("novamem-specific");
    expect(novamem.queries[0]?.forbiddenMemoryIds).toEqual(["old"]);
  });
});
