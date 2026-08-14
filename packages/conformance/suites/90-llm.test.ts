import { afterAll, describe, expect, it } from "vitest";
import { adminCookieApi, api, ns } from "../src/client.js";
import { env, hasAdminIdentity } from "../src/env.js";
import { MemoryEntry, ObserveResponse, RecentResponse, RememberResponse } from "../src/schemas.js";

/**
 * The three LLM subsystems the parity audit parked as "accepted
 * divergence #14" and later closed: fact extraction
 * (NOVAMEM_EXTRACTION_*), the observer (NOVAMEM_OBSERVER_*, which backs
 * `/v1/observe` and `/v1/context-prefix`), and query decomposition
 * (NOVAMEM_QUERY_DECOMP_*, `decompose: true` on `/v1/search`).
 *
 * Transcription sources (read-only): `engine/index.ts`
 * (`storeFactsForChunk` — derived facts land in the SAME namespace as
 * their chunk, carrying `metadata.fact` and
 * `metadata.source_chunk_id` → the chunk's id), `engine/observer.ts`,
 * `engine/query-decomposer.ts`, `routes/data-plane.ts`.
 *
 * GATING. `NOVAMEM_LLM_SUBSYSTEMS=1` asserts the subsystems are ON and
 * fails when they don't behave. Without it these tests skip LOUDLY —
 * they never silently pass, because a silent pass is exactly how a
 * missing subsystem stayed invisible through a green conformance run.
 *
 * These are REAL LLM round-trips against the target's configured
 * endpoint, so the timeouts are generous and the retries bounded.
 */

const NS = ns();
const createdIds = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdIds].map((id) => api("/v1/forget", { body: { id } }).catch(() => {})),
  );
});

const loud = (why: string) => it.skip(`SKIPPED — ${why}`, () => {});

if (!env.llmSubsystems) {
  loud("NOVAMEM_LLM_SUBSYSTEMS is not set; extraction/observer/decomposition are unverified");
}

const gated = describe.skipIf(!env.llmSubsystems);

gated("observer", () => {
  it("GET /v1/context-prefix returns a well-formed prefix", async () => {
    const r = await api<{ prefix: string }>("/v1/context-prefix");
    expect(
      r.status,
      "observer is disabled on this target but NOVAMEM_LLM_SUBSYSTEMS=1 was declared",
    ).toBe(200);
    expect(typeof r.body.prefix).toBe("string");
  });

  it.skipIf(!hasAdminIdentity)(
    "POST /v1/observe runs the observer pass for an operator",
    async () => {
      const denied = await api("/v1/observe", { body: {} });
      expect(denied.status).toBe(401);

      const r = await adminCookieApi<unknown>("/v1/observe", { body: {} });
      // 503 is the "observer configured but its endpoint is unreachable"
      // answer; with the subsystem declared on we require the real one.
      expect(r.status, `observe → ${JSON.stringify(r.body)}`).toBe(200);
      ObserveResponse.parse(r.body);
    },
    180_000,
  );

  if (!hasAdminIdentity) {
    loud("POST /v1/observe needs an admin session cookie (operator-gated)");
  }
});

gated("query decomposition", () => {
  it("POST /v1/search with decompose:true returns a well-formed result set", async () => {
    // Deliberately multi-hop so the decomposer has something to split.
    // The contract asserted here is SHAPE, not ranking: decomposition is
    // a retrieval-quality feature, and pinning which entries come back
    // would make this a model-version test rather than a contract test.
    const body = {
      query: "which storage layer does the cluster use and who prefers espresso",
      k: 5,
      decompose: true,
    };
    const r = await api<unknown>("/v1/search", { body });
    expect(r.status).toBe(200);
    const parsed = RecentResponse.parse(r.body);
    for (const e of parsed.results) MemoryEntry.parse(e);
    const scores = parsed.results.map((e) => MemoryEntry.parse(e).score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    // decompose:true must not change the response ENVELOPE — clients
    // parse both the same way.
    const plain = await api<unknown>("/v1/search", { body: { ...body, decompose: false } });
    expect(plain.status).toBe(200);
    RecentResponse.parse(plain.body);
    expect(Object.keys(r.body as object).sort()).toEqual(Object.keys(plain.body as object).sort());
  }, 120_000);
});

gated("fact extraction", () => {
  it("a written chunk yields derived facts pointing back at it", async () => {
    const marker = `conformance extraction probe ${NS}`;
    const chunk = await api<unknown>("/v1/remember", {
      body: {
        namespace: NS,
        content:
          `Pascal runs the kw Kubernetes cluster from Dubai, uses Longhorn for replicated ` +
          `block storage, and pulls espresso on a Lelit Bianca every morning. (${marker})`,
      },
    });
    expect(chunk.status).toBe(201);
    const chunkId = RememberResponse.parse(chunk.body).id;
    expect(chunkId, "worthiness gate rejected the extraction probe chunk").toBeTruthy();
    createdIds.add(chunkId!);

    // Extraction is fire-and-forget off the write path: one LLM call plus
    // one batched embed, then N inserts. Bounded poll — 120s at 3s is far
    // above the observed few seconds, and fails loudly rather than hanging.
    let derived: Array<{ id: string; content: string; metadata?: Record<string, unknown> }> = [];
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const recent = await api<unknown>("/v1/recent", { body: { namespace: NS, k: 200 } });
      if (recent.status === 200) {
        const all = RecentResponse.parse(recent.body).results.map((e) => MemoryEntry.parse(e));
        // Everything in this run's private namespace is ours to clean up,
        // including the derived facts we never asked for by id.
        for (const e of all) createdIds.add(e.id);
        derived = all.filter(
          (e) => (e.metadata as { source_chunk_id?: string } | undefined)?.source_chunk_id === chunkId,
        );
        if (derived.length > 0) break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    expect(
      derived.length,
      "no derived facts appeared within 120s — extraction is off on this target",
    ).toBeGreaterThan(0);

    for (const f of derived) {
      // Derived facts stay in their chunk's namespace and carry the
      // structured fact object the answerer joins on.
      const fact = (f.metadata as { fact?: Record<string, unknown> }).fact;
      expect(fact, `derived entry ${f.id} has no metadata.fact`).toBeTruthy();
      expect(typeof fact!.subject).toBe("string");
      expect(typeof fact!.predicate).toBe("string");
      // `factToText`: `[<type>] <subject> <predicate> <object>`. The type
      // is the extractor's taxonomy (fact / preference / event / …), so
      // the prefix must be derived from the metadata, not hard-coded.
      expect(typeof fact!.type).toBe("string");
      expect(f.content.startsWith(`[${String(fact!.type)}] `), f.content).toBe(true);
    }
  }, 180_000);
});
