import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/index.js";

function capturing(): { client: Client; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response('{"results": []}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    client: new Client({
      baseUrl: "http://novamem.test",
      token: "nm_x",
      fetch,
    }),
    bodies,
  };
}

// proved by: sending timestamp fields through clean() without utc() fails
// this test.
test("timestamps are sent as UTC with a Z, whether given as Date or string", async () => {
  const { client, bodies } = capturing();
  await client.recent({ since: "2026-09-24T12:00:00+02:00" });
  await client.recent({ since: new Date(Date.UTC(2026, 8, 24, 10)) });
  assert.deepEqual(bodies, [
    { since: "2026-09-24T10:00:00.000Z" },
    { since: "2026-09-24T10:00:00.000Z" },
  ]);
});

test("a timestamp that does not parse is sent unchanged, for the server to answer", async () => {
  const { client, bodies } = capturing();
  await client.recent({ since: "yesterday-ish" });
  assert.deepEqual(bodies, [{ since: "yesterday-ish" }]);
});
