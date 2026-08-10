/**
 * Phase 5 EXPERIMENT wiring tests. These lock the flag semantics, not
 * the quality claim — the quality claim is decided by the n≥50 gate and
 * this whole feature is deleted if it loses.
 *
 *  - `rerank: true` + configured service → cross-encoder order wins
 *  - service failure → fused order, search still succeeds
 *  - no service configured → flag is ignored (like `decompose`)
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";
import type { SearchReranker } from "./reranker.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

const DOCS = [
  "the deploy target for the bench cluster is 192.168.10.121",
  "the user prefers oat milk in coffee",
  "postgres runs on the bench cluster behind kube-vip",
];

async function seed(b: ReturnType<typeof makeEngine>) {
  for (const content of DOCS) {
    await b.engine.remember("u1", { content, force: true });
  }
}

/** A reranker that scores by position in `preferred` — last wins. */
function fakeReranker(preferred: string): Pick<SearchReranker, "rerank"> {
  return {
    async rerank(_query: string, documents: string[]) {
      return documents.map((d) => (d.includes(preferred) ? 10 : 1));
    },
  };
}

describe("search-time rerank (Phase 5 experiment)", () => {
  it("re-orders the pool by cross-encoder score when enabled", async () => {
    const b = quiet(makeEngine({
      reranker: fakeReranker("oat milk") as SearchReranker,
    }));
    await seed(b);
    const r = await b.engine.search("u1", { query: "bench cluster deploy", k: 3, rerank: true });
    expect(r.results.length).toBeGreaterThan(1);
    expect(r.results[0]!.content).toContain("oat milk");
  });

  it("falls back to fused order when the service fails, without failing the search", async () => {
    const failing: Pick<SearchReranker, "rerank"> = {
      async rerank() {
        throw new Error("rerank endpoint 503");
      },
    };
    const b = quiet(makeEngine({ reranker: failing as SearchReranker }));
    await seed(b);
    const withFlag = await b.engine.search("u1", { query: "bench cluster deploy", k: 3, rerank: true });
    const without = await b.engine.search("u1", { query: "bench cluster deploy", k: 3 });
    expect(withFlag.results.map((x) => x.id)).toEqual(without.results.map((x) => x.id));
  });

  it("ignores the flag when no reranker is configured", async () => {
    const b = quiet(makeEngine());
    await seed(b);
    const withFlag = await b.engine.search("u1", { query: "bench cluster deploy", k: 3, rerank: true });
    const without = await b.engine.search("u1", { query: "bench cluster deploy", k: 3 });
    expect(withFlag.results.map((x) => x.id)).toEqual(without.results.map((x) => x.id));
  });
});
