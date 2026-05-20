import { describe, expect, it, vi } from "vitest";

import {
  buildLongMemEvalAnswerPrompt,
  chunkLongMemEvalSession,
  normalizeLongMemEvalCutoffs,
  parseJudgeJson,
} from "../src/longmemeval-live.js";
import { createLocalVllmClient } from "../src/local-vllm.js";

describe("LongMemEval live runner helpers", () => {
  it("accepts top_200 once NovaMem search is configured for benchmark comparability", () => {
    expect(normalizeLongMemEvalCutoffs([10, 20, 50, 200])).toEqual([10, 20, 50, 200]);
  });

  it("still rejects cutoffs above the configured NovaMem search limit", () => {
    expect(() => normalizeLongMemEvalCutoffs([10, 20, 50, 200], 100)).toThrow(/top_200.*k <= 100/);
  });

  it("chunks sessions into small user/assistant pairs for direct remember ingestion", () => {
    const chunks = chunkLongMemEvalSession({
      questionId: "q1",
      sessionId: "s1",
      date: "2023/05/30 (Tue) 17:27",
      turns: [
        { role: "user", content: "I graduated with a degree in Business Administration." },
        { role: "assistant", content: "Congratulations." },
        { role: "user", content: "Please recommend task apps." },
      ],
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).toContain("question=q1 session=s1 chunk=0");
    expect(chunks[0]?.content).toContain("Business Administration");
    expect(chunks[1]?.content).toContain("chunk=1");
  });

  it("does not truncate the known answer out of a retrieved LongMemEval memory", () => {
    const longPrefix = "irrelevant ".repeat(500);
    const prompt = buildLongMemEvalAnswerPrompt({
      question: "What degree did I graduate with?",
      questionDate: "2023/05/30 (Tue) 23:40",
      memories: [
        { memory: `${longPrefix} user: I graduated with a degree in Business Administration.`, score: 0.4 },
      ],
      maxCharsEach: 8000,
      maxTotalChars: 20000,
    });

    expect(prompt).toContain("Business Administration");
  });

  it("parses strict and fenced judge JSON", () => {
    expect(parseJudgeJson('{"judgment":"PASS","score":1,"reason":"ok"}').score).toBe(1);
    expect(parseJudgeJson('```json\n{"judgment":"FAIL","score":0,"reason":"no"}\n```').score).toBe(0);
  });
});

describe("local vLLM client", () => {
  it("calls the configured OpenAI-compatible local vLLM endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("qwen3.6-35b");
      expect(body.messages[0].content).toBe("hello");
      return new Response(JSON.stringify({ choices: [{ message: { content: "world" } }] }), { status: 200 });
    });

    const client = createLocalVllmClient({
      baseUrl: "http://192.168.10.246:8888/v1",
      model: "qwen3.6-35b",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.generate("hello")).resolves.toBe("world");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.10.246:8888/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
