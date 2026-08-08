/**
 * Regression lock for the silent-no-op bug: every LLM-backed feature read
 * `choices[0].message.content ?? ""`, which turns a reasoning model's
 * "still thinking, no content yet" into "the model found nothing". On
 * nova-bench that made fact extraction, Mem0-style updation, query
 * decomposition, coherence rerank and the observer all inert — enabled,
 * configured, logging nothing, doing nothing.
 */
import { describe, expect, it } from "vitest";

import { chatCompletionBody, readCompletionText } from "./llm-response.js";

describe("readCompletionText", () => {
  it("returns content when the model produced some", () => {
    const r = readCompletionText({ choices: [{ message: { content: '[{"a":1}]' } }] });
    expect(r.text).toBe('[{"a":1}]');
    expect(r.emptyReason).toBeUndefined();
  });

  it("does not report reasoning-only responses as empty output", () => {
    // The exact shape observed from qwen3-6-35b-a3b-nvfp4: all tokens
    // spent reasoning, content still null.
    const r = readCompletionText({
      choices: [{ message: { content: null, reasoning: "x".repeat(3558) }, finish_reason: "length" }],
    });
    expect(r.text).toBe("");
    expect(r.emptyReason).toMatch(/reasoning only/);
    expect(r.emptyReason).toMatch(/3558/);
  });

  it("distinguishes a truncated response from a reasoning-only one", () => {
    const r = readCompletionText({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
    expect(r.emptyReason).toMatch(/max_tokens/);
    expect(r.emptyReason).not.toMatch(/reasoning/);
  });

  it("reports a response with no choices rather than returning empty text silently", () => {
    expect(readCompletionText({ choices: [] }).emptyReason).toMatch(/no choices/);
    expect(readCompletionText(null).emptyReason).toMatch(/no choices/);
  });

  it("treats whitespace-only content as no content", () => {
    expect(readCompletionText({ choices: [{ message: { content: "   \n" } }] }).emptyReason).toBeTruthy();
  });
});

describe("chatCompletionBody", () => {
  it("asks the endpoint to suppress chain of thought", () => {
    const body = JSON.parse(
      chatCompletionBody({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 128 }),
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0);
  });
});
