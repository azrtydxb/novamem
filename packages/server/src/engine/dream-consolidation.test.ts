/**
 * Phase 3 of the Mem0 alignment (docs/architecture/mem0-alignment.md):
 * semantic supersession runs in the dream-cycle, in batch, off the write
 * path — the compensator for single-pass ADD-only writes. The LLM judges
 * clusters of similar active facts; verdicts mark the loser inactive with
 * the same metadata convention search already filters on, and record a
 * bitemporal `supersedes` edge.
 */
import { describe, expect, it } from "vitest";

import { makeEngine } from "../test-fakes.js";
import { __test } from "./fact-extractor.js";

function quiet(b: ReturnType<typeof makeEngine>) {
  b.engine.setLogger({ warn: () => {}, error: () => {}, info: () => {} });
  return b;
}

async function seedFact(b: ReturnType<typeof makeEngine>, content: string, occurredAt: string) {
  const id = await b.warm.insertEntry({
    userId: "u1",
    projectId: null,
    content,
    namespace: "default",
    source: "manual",
    agentName: null,
    metadata: { fact: { type: "knowledge", occurred_at: occurredAt } },
    sourceType: "fact",
    capturedFrom: null,
    contentHash: "h-" + content.slice(0, 24),
  });
  const [emb] = await b.embedder.embed(content);
  await b.cold.upsert({ userId: "u1", projectId: null, id, namespace: "default", embedding: emb!, payload: {} });
  await b.warm.setEmbeddedAt(id, new Date());
  return id;
}

function consolidatingExtractor(verdict: (ids: string[]) => Array<{ supersededId: string; byId: string }>) {
  const state = { consolidateCalls: 0, clustersSeen: 0 };
  return {
    state,
    async extract() {
      return [];
    },
    async consolidate(clusters: Array<Array<{ id: string; text: string }>>) {
      state.consolidateCalls += 1;
      state.clustersSeen += clusters.length;
      return clusters.flatMap((c) => verdict(c.map((f) => f.id)));
    },
  };
}

describe("dream-cycle fact consolidation", () => {
  it("supersedes the older fact in a cluster and hides it from search", async () => {
    const ex = consolidatingExtractor((ids) =>
      ids.length >= 2 ? [{ supersededId: ids[1]!, byId: ids[0]! }] : [],
    );
    const b = quiet(makeEngine({ extractor: ex }));
    const newer = await seedFact(b, "the user lives in Dubai Marina", "2026-08-01");
    const older = await seedFact(b, "the user lives in Berlin Mitte", "2024-02-01");

    const r = await b.engine.dreamCycle({ maxEntries: 0, factClusterMinCosine: 0.1 });
    expect(r.factsWalked).toBeGreaterThan(0);
    expect(r.factsSuperseded).toBeGreaterThanOrEqual(1);

    const supersededRow = [...b.warm.rows.values()].find(
      (x) => x.metadata && (x.metadata as Record<string, unknown>).fact_inactive === true,
    );
    expect(supersededRow).toBeTruthy();
    expect((supersededRow!.metadata as Record<string, string>).superseded_via).toBe(
      "dream_cycle_consolidation",
    );
    // Bitemporal supersedes edge recorded.
    expect(
      b.warm.relations.some((e) => e.relation === "supersedes"),
    ).toBe(true);
    // Search no longer returns the inactive fact.
    const s = await b.engine.search("u1", { query: "where does the user live", k: 10 });
    const ids = s.results.map((x) => x.id);
    expect(ids).toContain(supersededRow!.id === older ? newer : older);
    expect(ids).not.toContain(supersededRow!.id);
  });

  it("supersession preserves the fact's existing metadata", async () => {
    // updateEntry replaces the metadata column wholesale; the verdict
    // application must merge, or retiring a fact would erase its
    // occurred_at / sensitivity / source_chunk_id provenance. (The old
    // write-time DELETE branch had exactly this latent bug.)
    const ex = consolidatingExtractor((ids) =>
      ids.length >= 2 ? [{ supersededId: ids[1]!, byId: ids[0]! }] : [],
    );
    const b = quiet(makeEngine({ extractor: ex }));
    await seedFact(b, "the user lives in Dubai Marina", "2026-08-01");
    await seedFact(b, "the user lives in Berlin Mitte", "2024-02-01");
    await b.engine.dreamCycle({ maxEntries: 0, factClusterMinCosine: 0.1 });
    const retired = [...b.warm.rows.values()].find(
      (x) => (x.metadata as Record<string, unknown>)?.fact_inactive === true,
    );
    expect(retired).toBeTruthy();
    const meta = retired!.metadata as { fact?: { occurred_at?: string } };
    expect(meta.fact?.occurred_at).toBeTruthy(); // provenance survived
  });

  it("judges clusters in one batched call, not per fact", async () => {
    const ex = consolidatingExtractor(() => []);
    const b = quiet(makeEngine({ extractor: ex }));
    await seedFact(b, "the user prefers oat milk in coffee", "2026-01-01");
    await seedFact(b, "the user prefers soy milk in coffee", "2025-01-01");
    await seedFact(b, "the user runs 5k every sunday morning", "2026-01-01");
    await seedFact(b, "the user runs 10k every saturday", "2026-02-01");

    await b.engine.dreamCycle({ maxEntries: 0, factClusterMinCosine: 0.1 });
    // Everything similar landed in clusters, and the LLM saw them in a
    // single call — the batch shape is the point of the phase.
    expect(ex.state.consolidateCalls).toBeLessThanOrEqual(1 + Math.floor(ex.state.clustersSeen / 8));
  });

  it("leaves coexisting facts alone when the model returns no pairs", async () => {
    const ex = consolidatingExtractor(() => []);
    const b = quiet(makeEngine({ extractor: ex }));
    await seedFact(b, "the user prefers oat milk in coffee", "2026-01-01");
    await seedFact(b, "the user prefers tea in the afternoon", "2026-01-01");
    const r = await b.engine.dreamCycle({ maxEntries: 0, factClusterMinCosine: 0.1 });
    expect(r.factsSuperseded).toBe(0);
    const inactive = [...b.warm.rows.values()].filter(
      (x) => (x.metadata as Record<string, unknown>)?.fact_inactive,
    );
    expect(inactive.length).toBe(0);
  });

  it("is a no-op without an extractor", async () => {
    const b = quiet(makeEngine());
    await seedFact(b, "the user lives in Dubai Marina", "2026-08-01");
    const r = await b.engine.dreamCycle({ maxEntries: 0 });
    expect(r.factsWalked).toBe(0);
    expect(r.factsSuperseded).toBe(0);
  });
});

describe("parseConsolidations", () => {
  const clusters = [
    [
      { id: "a1", text: "x" },
      { id: "a2", text: "y" },
    ],
    [
      { id: "b1", text: "z" },
      { id: "b2", text: "w" },
    ],
  ];

  it("accepts pairs within a cluster", () => {
    const out = __test.parseConsolidations(
      '[{"group":1,"superseded":"a2","by":"a1"}]',
      clusters,
    );
    expect(out).toEqual([{ supersededId: "a2", byId: "a1" }]);
  });

  it("rejects invented ids and cross-cluster pairs", () => {
    const out = __test.parseConsolidations(
      '[{"superseded":"zz","by":"a1"},{"superseded":"a2","by":"b1"},{"superseded":"b2","by":"b2"}]',
      clusters,
    );
    expect(out).toEqual([]);
  });

  it("survives fenced / prose-wrapped output", () => {
    const out = __test.parseConsolidations(
      '```json\n[{"superseded":"b2","by":"b1"}]\n```',
      clusters,
    );
    expect(out).toEqual([{ supersededId: "b2", byId: "b1" }]);
  });
});
