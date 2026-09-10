/**
 * Response-shape locks for three type/wire mismatches a Go client found by
 * writing against this API rather than against these declarations.
 *
 * A wrong response type here is worse than an untyped client: it makes the
 * compiler agree with a claim the server never made. Each test drives the
 * real client against a mock that returns exactly what the server returns.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  NovamemClient,
  type CaptureResponse,
  type SessionRecapResponse,
} from "../src/index.js";

function makeClient(responseBody: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      })
  );
  const client = new NovamemClient({
    baseUrl: "https://novamem.test",
    token: "nm_test_bearer",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

describe("capture() returns the engine's result, not a recap envelope", () => {
  it("surfaces id / deduplicated / superseded as sent by /v1/capture", async () => {
    // The real 201 body. `CaptureResponse` used to declare
    // `{saved, results[]}` — /v1/session-recap's shape — so every field a
    // caller actually needed was invisible to the compiler.
    const { client } = makeClient({
      id: "01HXYZ",
      deduplicated: true,
      updated: true,
      superseded: ["01HOLD"],
      embedded: true,
    });

    const out = await client.capture({ content: "pascal prefers dark roast" });

    expect(out.id).toBe("01HXYZ");
    expect(out.deduplicated).toBe(true);
    expect(out.superseded).toEqual(["01HOLD"]);
    expectTypeOf(out).toEqualTypeOf<CaptureResponse>();
    expectTypeOf(out.id).toEqualTypeOf<string | null>();
  });

  it("carries `embedded` so a caller can tell stored-and-searchable from stored-only", async () => {
    const { client } = makeClient({ id: "01HXYZ", embedded: false });

    const out = await client.capture({
      content: "written during an embedder outage",
    });

    // Stored and durable, but not yet findable by semantic search.
    expect(out.id).toBe("01HXYZ");
    expect(out.embedded).toBe(false);
  });

  it("models a gate rejection as id:null + reason rather than a thrown error", async () => {
    const { client } = makeClient({
      id: null,
      rejected: "too short — not durable knowledge",
    });

    const out = await client.capture({ content: "ok" });

    expect(out.id).toBeNull();
    expect(out.rejected).toBeTruthy();
  });

  it("keeps the {saved, results} envelope on sessionRecap, where it belongs", async () => {
    const { client } = makeClient({
      saved: 1,
      results: [{ id: "01HXYZ", embedded: true }],
    });

    const out = await client.sessionRecap({ decisions: ["we chose drizzle"] });

    expect(out.saved).toBe(1);
    expect(out.results[0]?.id).toBe("01HXYZ");
    expectTypeOf(out).toEqualTypeOf<SessionRecapResponse>();
  });
});

describe("forget() surfaces coldDeleteOk", () => {
  it("reports a half-completed delete instead of reading as fully forgotten", async () => {
    // Warm row gone, vector copy survived and was queued for the reaper.
    // The client previously dropped this field, so a user who asked to be
    // forgotten was told they had been.
    const { client } = makeClient({ deleted: true, coldDeleteOk: false });

    const out = await client.forget("01HABC");

    expect(out.deleted).toBe(true);
    expect(out.coldDeleteOk).toBe(false);
    expectTypeOf(out).toEqualTypeOf<{
      deleted: boolean;
      coldDeleteOk: boolean;
    }>();
  });

  it("reports a fully-completed delete", async () => {
    const { client } = makeClient({ deleted: true, coldDeleteOk: true });

    const out = await client.forget("01HABC");

    expect(out).toEqual({ deleted: true, coldDeleteOk: true });
  });
});

describe("search() distinguishes degraded-with-results from could-not-look", () => {
  it("throws on the server's 503 rather than returning an empty result set", async () => {
    const { client } = makeClient(
      {
        results: [],
        degraded: true,
        error: "search degraded: a backing tier was unavailable",
      },
      503
    );

    // Must not resolve to `{results: []}` — that would restate "I could not
    // look" as "you have no such memory", which is the bug being fixed.
    await expect(client.search({ query: "coffee" })).rejects.toThrow(/503/);
  });

  it("resolves a 200 that is degraded but carries real results", async () => {
    const { client } = makeClient({
      results: [
        {
          id: "01HXYZ",
          score: 1,
          content: "c",
          tier: "warm",
          namespace: "default",
          project: null,
          source: "manual",
          metadata: {},
        },
      ],
      degraded: true,
    });

    const out = await client.search({ query: "coffee" });

    expect(out.degraded).toBe(true);
    expect(out.results).toHaveLength(1);
  });
});
