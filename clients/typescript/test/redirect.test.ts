import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "../src/index.js";

function listen(
  handler: Parameters<typeof createServer>[1]
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      })
    );
  });
}

// proved by: removing the cross-origin `delete headers.Authorization` in
// Transport.#follow fails this test.
test("a cross-origin redirect drops the bearer", async () => {
  let seen: string | undefined = "unset";
  const target = await listen((req, res) => {
    seen = req.headers.authorization;
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok": true}');
  });
  // 127.0.0.1 vs localhost: a different origin for the same host.
  const origin = await listen((_req, res) => {
    res.statusCode = 302;
    res.setHeader(
      "Location",
      target.url.replace("127.0.0.1", "localhost") + "/health"
    );
    res.end();
  });
  try {
    assert.equal(
      await new Client({ baseUrl: origin.url, token: "nm_secret" }).health(),
      true
    );
    assert.equal(
      seen,
      undefined,
      "the bearer followed a redirect to another origin"
    );
  } finally {
    origin.server.close();
    target.server.close();
  }
});

test("a same-origin redirect keeps the bearer", async () => {
  let seen: string | undefined;
  const both = await listen((req, res) => {
    if (req.url === "/health") {
      res.statusCode = 302;
      res.setHeader("Location", "/moved");
      res.end();
      return;
    }
    seen = req.headers.authorization;
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok": true}');
  });
  try {
    assert.equal(
      await new Client({ baseUrl: both.url, token: "nm_secret" }).health(),
      true
    );
    assert.equal(seen, "Bearer nm_secret");
  } finally {
    both.server.close();
  }
});
