import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ns } from "../src/client.js";
import { MemoryEntry, RecentResponse, RememberResponse } from "../src/schemas.js";

/**
 * Live oracle for this suite runs real embeddings (bge-m3 @
 * http://192.168.10.125/v1) plus an extraction LLM on remember — seeding
 * 8 entries triggers 8 real embedding calls, and indexing is async, so
 * the `beforeAll` polls /v1/recent until all seeded ids are visible
 * before any search test runs. Differential runs against another oracle
 * must pin the same embedding model or vector-signal assertions here
 * (e.g. "espresso" ranking near "coffee machine") may not transfer.
 */

const NS = ns();

// Eight-entry corpus with three separable topics (cluster infra, coffee,
// novamem storage internals) plus two unrelated distractors, so topical
// search has clear true positives and negatives to check against. All
// entries are substantive declarative facts — the worthiness gate
// (POST /v1/remember can return `id: null` + `rejected` for trivial
// content) rejects thin filler, so every string here carries a concrete
// subject + claim rather than a fragment.
//
// Base strings are templated with the run's namespace suffix (see
// `corpusFor` below) rather than kept fully static: /v1/remember dedupes
// by content across the caller's whole account, not scoped to namespace,
// so a byte-identical corpus across two conformance runs returns the
// *first* run's id sitting in the *first* run's (now-forgotten) namespace
// — invisible to this run's `/v1/recent` poll. The suffix keeps content
// unique per run while leaving the topic keywords assertions key off
// (`espresso`, `Longhorn`, `vector`, ...) untouched.
const CORPUS_BASE = [
  "The kw cluster ingress uses Cilium with kube-vip to provide the shared VIP for ingress-nginx",
  "Longhorn provides replicated block storage for stateful workloads on the kw cluster",
  "Pascal prefers espresso over filter coffee in the morning and drinks it before starting work",
  "The espresso machine in Pascal's kitchen is a Lelit Bianca with PID temperature control and flow profiling",
  "novamem stores memories in a warm Postgres tier for recent data and a cold vector tier for older data",
  "The novamem cold vector tier supports both pgvector and Qdrant as backend implementations",
  "The tax filing deadline for the 2026 fiscal year in Belgium is at the end of April",
  "The cat's vet appointment for its annual checkup is scheduled on Fridays",
];
const corpusFor = (nsName: string): string[] =>
  CORPUS_BASE.map((fact) => `${fact} (conformance run ${nsName})`);

const seededIds: string[] = [];

/** Seeds the corpus into `NS` and polls /v1/recent until every seeded id
 *  is visible, since async enrichment means the 201 can precede indexing.
 *  Throws on any worthiness-gate rejection (`id: null`) — a silently-thin
 *  corpus would make every downstream membership/ranking assertion
 *  meaningless, so this must fail loudly rather than skip. */
async function seedCorpus(nsName: string): Promise<string[]> {
  const ids: string[] = [];
  for (const content of corpusFor(nsName)) {
    const r = await api<unknown>("/v1/remember", { body: { content, namespace: nsName } });
    if (r.status !== 201) {
      throw new Error(`seed failed: HTTP ${r.status} for "${content}"`);
    }
    const parsed = RememberResponse.parse(r.body);
    if (!parsed.id) {
      throw new Error(
        `seed rejected by worthiness gate (rejected="${parsed.rejected}") for: "${content}"`,
      );
    }
    ids.push(parsed.id);
  }

  const deadline = Date.now() + 45_000;
  let visible = new Set<string>();
  while (Date.now() < deadline) {
    // k is intentionally much larger than the corpus size: the oracle runs
    // an async observer/extraction pass that derives additional `[fact]
    // ...]` entries per seeded item (visible in manual probing), which
    // crowd a tight `k` window in /v1/recent's recency ordering and can
    // push original seeded ids out of a same-size k before extraction
    // settles.
    const r = await api<unknown>("/v1/recent", { body: { namespace: nsName, k: 200 } });
    if (r.status === 200) {
      const parsed = RecentResponse.parse(r.body);
      visible = new Set(parsed.results.map((e) => e.id));
      if (ids.every((id) => visible.has(id))) return ids;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const missing = ids.filter((id) => !visible.has(id));
  throw new Error(`seed indexing did not converge within 45s; missing ids: ${missing.join(", ")}`);
}

beforeAll(async () => {
  seededIds.push(...(await seedCorpus(NS)));
}, 120_000);

afterAll(async () => {
  await Promise.all(
    seededIds.map((id) => api("/v1/forget", { body: { id } }).catch(() => {})),
  );
});

describe("hybrid search", () => {
  it("POST /v1/search finds topical matches in top-k", async () => {
    const r = await api<unknown>("/v1/search", {
      body: { query: "coffee machine", namespace: NS, k: 4 },
    });
    expect(r.status).toBe(200);
    const entries = RecentResponse.parse(r.body).results.map((e) => MemoryEntry.parse(e));
    expect(entries.some((e) => e.content.includes("espresso"))).toBe(true);
  });

  it("POST /v1/search scores are monotonically non-increasing", async () => {
    const r = await api<unknown>("/v1/search", {
      body: { query: "vector storage backend", namespace: NS, k: 8 },
    });
    expect(r.status).toBe(200);
    const entries = RecentResponse.parse(r.body).results.map((e) => MemoryEntry.parse(e));
    const scores = entries.map((e) => e.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("POST /v1/search scopes results to the requested namespace", async () => {
    const r = await api<unknown>("/v1/search", {
      body: { query: "cluster storage", namespace: NS, k: 8 },
    });
    expect(r.status).toBe(200);
    const entries = RecentResponse.parse(r.body).results.map((e) => MemoryEntry.parse(e));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      if (e.namespace !== undefined) expect(e.namespace).toBe(NS);
    }
  });

  it("POST /v1/neighbors returns graph-adjacent entries for a seeded id", async () => {
    const seedId = seededIds[0];
    const r = await api<unknown>("/v1/neighbors", { body: { id: seedId } });
    expect(r.status).toBe(200);
    const parsed = RecentResponse.parse(r.body);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it("POST /v1/context responds 200 with a relevant + recent context pack", async () => {
    const r = await api<{
      relevant: { results: unknown[]; degraded: boolean };
      recent: { results: unknown[]; degraded: boolean };
      contextPack: unknown;
      guidance: string;
    }>("/v1/context", { body: { message: "tell me about cluster storage", namespace: NS } });
    expect(r.status).toBe(200);
    const relevantEntries = r.body.relevant.results.map((e) => MemoryEntry.parse(e));
    expect(relevantEntries.some((e) => e.content.includes("Longhorn") || e.content.includes("vector"))).toBe(
      true,
    );
    expect(typeof r.body.guidance).toBe("string");
  });

  it("GET /v1/context-prefix responds 200 with a prefix or 404 when the observer is disabled", async () => {
    const r = await api<{ prefix: string } | { error: string }>("/v1/context-prefix");
    expect([200, 404]).toContain(r.status);
    if (r.status === 200) {
      expect(typeof (r.body as { prefix: string }).prefix).toBe("string");
    } else {
      expect(typeof (r.body as { error: string }).error).toBe("string");
    }
  });
});
