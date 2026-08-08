import { describe, expect, it } from "vitest";
import { chatCompletionsURL, stripTrailingSlashes } from "./endpoint-url.js";

describe("endpoint URL building", () => {
  it("strips any number of trailing slashes and nothing else", () => {
    expect(stripTrailingSlashes("http://h/v1")).toBe("http://h/v1");
    expect(stripTrailingSlashes("http://h/v1/")).toBe("http://h/v1");
    expect(stripTrailingSlashes("http://h/v1///")).toBe("http://h/v1");
    // interior slashes must survive — only the tail is trimmed
    expect(stripTrailingSlashes("http://h//a//b//")).toBe("http://h//a//b");
    expect(stripTrailingSlashes("")).toBe("");
    expect(stripTrailingSlashes("////")).toBe("");
  });

  it("builds the chat-completions URL", () => {
    expect(chatCompletionsURL("http://h/v1")).toBe("http://h/v1/chat/completions");
    expect(chatCompletionsURL("http://h/v1//")).toBe("http://h/v1/chat/completions");
  });

  // The reason this helper exists: `replace(/\/+$/, "")` backtracks from every
  // position in a long run of slashes, so the work is quadratic. A linear scan
  // is flat. 100k slashes would take visible seconds under the regex; this
  // must stay in the noise.
  it("is linear on a pathological all-slashes input", () => {
    const pathological = "/".repeat(100_000);
    const started = performance.now();
    expect(stripTrailingSlashes(pathological)).toBe("");
    expect(performance.now() - started).toBeLessThan(50);
  });
});
