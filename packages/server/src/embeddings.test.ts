import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEmbedder, resolvePrefixes, resolvePrefixesWithSource } from "./embeddings.js";

describe("embeddings: factory", () => {
  it("rejects unknown provider", () => {
    expect(() =>
      makeEmbedder({ provider: "madeup" as never, dimensions: 384 }),
    ).toThrow(/unknown embeddings provider/);
  });

  it("openai-compatible factory requires endpoint + model", () => {
    expect(() =>
      makeEmbedder({ provider: "openai-compatible", dimensions: 384 } as never),
    ).toThrow(/endpoint/);
    expect(() =>
      makeEmbedder({ provider: "openai-compatible", endpoint: "http://x", dimensions: 384 } as never),
    ).toThrow(/model/);
  });
});

describe("embeddings: openai-compatible adapter", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /embeddings with model + input and returns the vectors", async () => {
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // Echo back a vector per input.
      const vectors = (Array.isArray(body.input) ? body.input : [body.input]).map((_: string, i: number) =>
        Array.from({ length: 4 }, (_v, j) => i * 4 + j),
      );
      return new Response(
        JSON.stringify({ data: vectors.map((embedding: number[]) => ({ embedding })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch;
    const embedder = makeEmbedder({
      provider: "openai-compatible",
      endpoint: "http://embedder.local/v1",
      model: "test-model",
      apiKey: "sk-test",
      dimensions: 4,
    });
    const out = await embedder.embed(["hello", "world"]);
    expect(out).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
    // Confirms /embeddings was hit and Authorization was forwarded.
    expect(fakeFetch).toHaveBeenCalledWith(
      "http://embedder.local/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer sk-test",
        }),
      }),
    );
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    const embedder = makeEmbedder({
      provider: "openai-compatible",
      endpoint: "http://embedder.local/v1",
      model: "test-model",
      dimensions: 4,
    });
    await expect(embedder.embed("anything")).rejects.toThrow(/embeddings http 500/);
  });
});

describe("Qwen3-Embedding prefix preset", () => {
  it("gives Qwen3-Embedding its instruction envelope on the query side only", () => {
    const p = resolvePrefixes("Qwen/Qwen3-Embedding-0.6B");
    expect(p.query).toMatch(/^Instruct: /);
    expect(p.query).toMatch(/\nQuery: $/);
    expect(p.document).toBe("");
  });

  it("matches the served-model-name form too", () => {
    expect(resolvePrefixes("qwen3-embedding-0.6b").query).toMatch(/^Instruct: /);
  });

  // bge-m3 is trained without prefixes, unlike the bge-*-en-v1.5 line.
  it("does not prefix bge-m3", () => {
    const p = resolvePrefixes("BAAI/bge-m3");
    expect(p.query).toBe("");
    expect(p.document).toBe("");
  });

  it("reports how the prefixes were resolved", () => {
    expect(resolvePrefixesWithSource("Qwen/Qwen3-Embedding-0.6B").source).toBe("preset");
    expect(resolvePrefixesWithSource("BAAI/bge-m3").source).toBe("none");
    expect(resolvePrefixesWithSource("anything", { query: "q: " }).source).toBe("explicit");
  });
});
