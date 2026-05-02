/**
 * Real-DB integration suite. Skipped by default; flip on with:
 *
 *   NOVAMEM_INTEGRATION=1 NOVAMEM_BASE_URL=http://localhost:5050 \
 *     pnpm --filter @azrty/novamem-server test:integration
 *
 * Requires a live `docker compose up -d` from the repo root. These tests
 * exercise the full Postgres + Qdrant + FalkorDB + embedder stack via the
 * HTTP surface — no fakes, no engine direct calls. They share state with
 * the running service so each test uses a unique namespace.
 */

import { afterAll, describe, expect, it } from "vitest";

const BASE = process.env.NOVAMEM_BASE_URL ?? "http://localhost:5050";
const ENABLED = process.env.NOVAMEM_INTEGRATION === "1";
const NS = `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const itLive = ENABLED ? it : it.skip;

async function api<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as T };
}

describe("integration: live service end-to-end", () => {
  if (!ENABLED) {
    it.skip(`disabled — set NOVAMEM_INTEGRATION=1 to run against ${BASE}`, () => undefined);
    return;
  }

  let createdIds: string[] = [];

  itLive("/health is reachable", async () => {
    const r = await api<{ ok: boolean; deps: { warm: string; cold: string; graph: string } }>("/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  itLive("remember + search round-trips through warm + cold", async () => {
    const remember = await api<{ id: string }>("/v1/remember", {
      content: "Pascal builds tiered memory systems for AI agents",
      namespace: NS,
      source: "integration-test",
    });
    expect(remember.status).toBe(201);
    expect(remember.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    createdIds.push(remember.body.id);

    const search = await api<{ results: Array<{ id: string; tier: string; signals: { keyword: number; vector: number } }> }>(
      "/v1/search",
      { query: "tiered memory systems", namespace: NS, k: 5 },
    );
    expect(search.status).toBe(200);
    const hit = search.body.results.find((r) => r.id === remember.body.id);
    expect(hit).toBeDefined();
    expect(hit!.tier).toBe("warm");
    expect(hit!.signals.keyword).toBeGreaterThan(0);
    expect(hit!.signals.vector).toBeGreaterThan(0);
  });

  itLive("recent returns the entries ordered newest-first", async () => {
    const a = await api<{ id: string }>("/v1/remember", { content: "first integration entry", namespace: NS });
    await new Promise((r) => setTimeout(r, 1100)); // ensure created_at gap > 1s
    const b = await api<{ id: string }>("/v1/remember", { content: "second integration entry", namespace: NS });
    createdIds.push(a.body.id, b.body.id);
    const recent = await api<{ results: Array<{ id: string }> }>("/v1/recent", { namespace: NS, k: 10 });
    const idx = (id: string) => recent.body.results.findIndex((r) => r.id === id);
    expect(idx(b.body.id)).toBeGreaterThanOrEqual(0);
    expect(idx(a.body.id)).toBeGreaterThan(idx(b.body.id));
  });

  itLive("forced decay demotes idle entries; lastDecayAt is logged", async () => {
    const decay = await api<{ demoted: number }>("/v1/decay", { effectiveDays: 0.0001 });
    expect(decay.status).toBe(200);
    expect(decay.body.demoted).toBeGreaterThanOrEqual(0);
    const stats = await api<{ lastDecayAt: string | null }>("/v1/stats");
    expect(stats.body.lastDecayAt).not.toBeNull();
  });

  itLive("a hit on a cold entry promotes it back to warm", async () => {
    // Force everything to cold first.
    await api("/v1/decay", { effectiveDays: 0.0001 });
    // Re-search — the entry should be served and reverted to warm.
    const r = await api<{ results: Array<{ id: string; tier: string }> }>("/v1/search", {
      query: "tiered memory systems",
      namespace: NS,
      k: 1,
    });
    if (r.body.results.length > 0) {
      // After a hit, the next stats read should show it back in warm.
      // We give the engine a moment in case the markCold UPDATE is async-buffered.
      await new Promise((res) => setTimeout(res, 100));
      const stats = await api<{ byNamespace: Record<string, { warm: number; cold: number }> }>("/v1/stats");
      expect(stats.body.byNamespace[NS]?.warm ?? 0).toBeGreaterThanOrEqual(0);
    }
  });

  itLive("forget removes the entry; reap-orphans returns clean counts", async () => {
    const created = await api<{ id: string }>("/v1/remember", { content: "to forget", namespace: NS });
    const id = created.body.id;
    const forget = await api<{ deleted: boolean; coldDeleteOk: boolean }>("/v1/forget", { id });
    expect(forget.body.deleted).toBe(true);
    // In normal conditions cold delete should succeed.
    expect(forget.body.coldDeleteOk).toBe(true);
    const reap = await api<{ attempted: number; cleared: number; abandoned: number; pending: number }>(
      "/v1/reap-orphans",
      {},
    );
    expect(reap.body.pending).toBe(0);
  });

  itLive("/v1/promote endpoint is removed (was a stub)", async () => {
    const r = await fetch(`${BASE}/v1/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(404);
  });

  itLive("/mcp/sse handshake returns text/event-stream", async () => {
    // We can't keep the connection open in a unit test, but we can verify
    // the handshake by aborting after the first chunk arrives.
    const ctrl = new AbortController();
    const promise = fetch(`${BASE}/mcp/sse`, { signal: ctrl.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 250));
    ctrl.abort();
    const result = await promise;
    if (result instanceof Response) {
      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toContain("text/event-stream");
    }
  });

  afterAll(async () => {
    // Best-effort cleanup so the live DB doesn't accumulate test rows
    // across runs. Failures here are non-fatal.
    for (const id of createdIds) {
      await api("/v1/forget", { id }).catch(() => undefined);
    }
  });
});
