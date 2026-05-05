/**
 * Client/server contract tests (issue #71).
 *
 * Spot-checks that `@azrtydxb/novamem`'s outgoing requests still match the
 * server's published `docs/api/openapi.json`. We don't run the real server —
 * we install a static `fetch` mock, drive each client method, and assert
 * the URL/method/body the client emitted match what the spec advertises.
 *
 * Specifically catches the two drift bugs that motivated this issue:
 *   - `revokeMyToken()` must hit `DELETE /v1/me/tokens/:hash` (was a stale
 *     `POST /v1/me/tokens/:hash/revoke` route).
 *   - `health()` response shape is `{ ok: boolean }` only — no `deps`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NovamemClient } from "../src/index.js";

// docs/api/openapi.json — repo root, three dirs up from this test file
// (packages/client/test → packages/client → packages → repo).
const here = dirname(fileURLToPath(import.meta.url));
const openapiPath = resolve(here, "../../../docs/api/openapi.json");
const openapi = JSON.parse(readFileSync(openapiPath, "utf8")) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
};

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a NovamemClient with a captured fetch mock. The mock returns the
 *  given JSON body for every call so the client's `request<T>()` can
 *  resolve. */
function makeClient(responseBody: unknown = {}, status = 200) {
  const calls: CapturedCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    }
    let body: unknown = undefined;
    if (init?.body && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers, body });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const client = new NovamemClient({
    baseUrl: "https://novamem.test",
    token: "nm_test_bearer",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, calls };
}

/** True if the spec advertises `method` for the literal `path`. */
function specHas(path: string, method: string): boolean {
  const entry = openapi.paths[path];
  return Boolean(entry && entry[method.toLowerCase()]);
}

describe("client contract: wire path + method match openapi.json", () => {
  it("health() — GET /health (and spec has it)", async () => {
    const { client, calls } = makeClient({ ok: true });
    const r = await client.health();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://novamem.test/health");
    expect(specHas("/health", "get")).toBe(true);
    expect(r).toEqual({ ok: true });
  });

  it("health() response shape is { ok } only — no deps (#50)", () => {
    const schema = openapi.components.schemas.Health;
    expect(schema).toBeDefined();
    expect(Object.keys(schema.properties ?? {})).toEqual(["ok"]);
    expect(schema.required).toEqual(["ok"]);
    // Defensive: deps must NOT appear on the public Health schema.
    expect(schema.properties).not.toHaveProperty("deps");
  });

  it("remember() — POST /v1/remember", async () => {
    const { client, calls } = makeClient({ id: "01HXYZ" });
    await client.remember({ content: "hello", namespace: "ns" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://novamem.test/v1/remember");
    expect(calls[0].body).toEqual({ content: "hello", namespace: "ns" });
    expect(calls[0].headers["authorization"]).toBe("Bearer nm_test_bearer");
    expect(specHas("/v1/remember", "post")).toBe(true);
  });

  it("search() — POST /v1/search", async () => {
    const { client, calls } = makeClient({ results: [], degraded: false });
    await client.search({ query: "coffee", k: 3 });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://novamem.test/v1/search");
    expect(calls[0].body).toEqual({ query: "coffee", k: 3 });
    expect(specHas("/v1/search", "post")).toBe(true);
  });

  it("recent() — POST /v1/recent", async () => {
    const { client, calls } = makeClient({ results: [], degraded: false });
    await client.recent({ k: 5 });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://novamem.test/v1/recent");
    expect(specHas("/v1/recent", "post")).toBe(true);
  });

  it("forget() — POST /v1/forget", async () => {
    const { client, calls } = makeClient({ deleted: true });
    await client.forget("01HABC");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://novamem.test/v1/forget");
    expect(calls[0].body).toEqual({ id: "01HABC" });
    expect(specHas("/v1/forget", "post")).toBe(true);
  });

  it("neighbors() — POST /v1/neighbors", async () => {
    const { client, calls } = makeClient({ results: [], degraded: false });
    await client.neighbors({ id: "01HABC", k: 4 });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://novamem.test/v1/neighbors");
    expect(specHas("/v1/neighbors", "post")).toBe(true);
  });

  it("stats() — GET /v1/stats", async () => {
    const { client, calls } = makeClient({
      byNamespace: {}, totalWarm: 0, totalCold: 0, lastDecayAt: null, uptimeMs: 1,
    });
    await client.stats();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://novamem.test/v1/stats");
    expect(specHas("/v1/stats", "get")).toBe(true);
  });

  it("listTokens() — GET /v1/me/tokens", async () => {
    const { client, calls } = makeClient({ tokens: [] });
    await client.listTokens();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://novamem.test/v1/me/tokens");
    expect(specHas("/v1/me/tokens", "get")).toBe(true);
  });

  it("revokeMyToken() — DELETE /v1/me/tokens/:hash, response { deleted } (NOT { revoked })", async () => {
    const { client, calls } = makeClient({ deleted: true });
    const hash = "a".repeat(64);
    const out = await client.revokeMyToken(hash);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(`https://novamem.test/v1/me/tokens/${hash}`);
    // openapi advertises the templated path.
    expect(specHas("/v1/me/tokens/{hash}", "delete")).toBe(true);
    // Wire shape is `{deleted: boolean}` — never the legacy `{revoked}`.
    expect(out).toEqual({ deleted: true });
    expect((out as Record<string, unknown>).revoked).toBeUndefined();
  });
});
