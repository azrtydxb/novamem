// Live round trip against a real server, for the sdk-smoke CI job.
//
//   NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… node smoke.mjs up|down
//
// up:   capture → search finds it → forget deletes it → search no longer finds it.
// down: the server has been stopped; search must report unavailable, not an
//       empty result. Every failure prints "typescript <step>: <detail>" and exits 1.
import { randomUUID } from "node:crypto";
import { Client, NovamemError, isUnavailable } from "./dist/index.js";

const fail = (step, detail) => {
  console.log(`typescript ${step}: ${detail}`);
  process.exit(1);
};

const mode = process.argv[2] ?? "up";
const c = new Client({
  baseUrl: process.env.NOVAMEM_SMOKE_URL,
  token: process.env.NOVAMEM_SMOKE_TOKEN,
});

if (mode === "down") {
  try {
    await c.search({ query: "anything" });
    fail("down", "search succeeded against a stopped server");
  } catch (e) {
    if (!isUnavailable(e)) fail("down", `want unavailable, got ${e}`);
  }
  console.log("PASS typescript down");
} else {
  const marker = randomUUID().replaceAll("-", "");
  let cap;
  try {
    cap = await c.capture({
      content: `sdk-smoke typescript ${marker}`,
      namespace: "sdk-smoke",
      force: true,
    });
  } catch (e) {
    fail("capture", e instanceof NovamemError ? e.message : String(e));
  }
  if (!cap.id) fail("capture", `not saved: ${JSON.stringify(cap)}`);
  const hits = await c.search({ query: marker, namespace: "sdk-smoke" });
  if (!hits.results.some((r) => r.id === cap.id))
    fail("search", `captured ${cap.id} not found`);
  const gone = await c.forget({ id: cap.id });
  if (!gone.deleted) fail("forget", JSON.stringify(gone));
  const after = await c.search({ query: marker, namespace: "sdk-smoke" });
  if (after.results.some((r) => r.id === cap.id))
    fail("search-after-forget", `${cap.id} still returned`);
  console.log("PASS typescript up");
}
