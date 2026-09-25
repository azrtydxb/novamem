// Live round trip against a real server, for the sdk-smoke CI job.
//
//   NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… node smoke.mjs up|down
//
// up:   capture → search finds it → forget deletes it → search no longer finds it.
// down: the server has been stopped; search must report unavailable, not an
//       empty result. Every failure prints "typescript <step>: <detail>" and exits 1.
import { randomUUID } from "node:crypto";
import { Client, isUnavailable } from "./dist/index.js";

const fail = (step, detail) => {
  console.log(`typescript ${step}: ${detail}`);
  process.exit(1);
};

/** Runs one step; any error becomes "typescript <name>: <detail>". */
const step = async (name, call) => {
  try {
    return await call();
  } catch (e) {
    fail(name, e instanceof Error ? e.message : String(e));
  }
};

async function down(c) {
  try {
    await c.search({ query: "anything" });
  } catch (e) {
    if (isUnavailable(e)) {
      console.log("PASS typescript down");
      return;
    }
    fail("down", `want unavailable, got ${e}`);
  }
  fail("down", "search succeeded against a stopped server");
}

async function up(c) {
  const marker = randomUUID().replaceAll("-", "");
  const query = { query: marker, namespace: "sdk-smoke" };
  const cap = await step("capture", () =>
    c.capture({
      content: `sdk-smoke typescript ${marker}`,
      namespace: "sdk-smoke",
      force: true,
    })
  );
  if (!cap.id) fail("capture", `not saved: ${JSON.stringify(cap)}`);
  const hits = await step("search", () => c.search(query));
  if (!hits.results.some((r) => r.id === cap.id))
    fail("search", `captured ${cap.id} not found`);
  const gone = await step("forget", () => c.forget({ id: cap.id }));
  if (!gone.deleted) fail("forget", JSON.stringify(gone));
  const after = await step("search-after-forget", () => c.search(query));
  if (after.results.some((r) => r.id === cap.id))
    fail("search-after-forget", `${cap.id} still returned`);
  console.log("PASS typescript up");
}

const c = await step(
  "connect",
  async () =>
    new Client({
      baseUrl: process.env.NOVAMEM_SMOKE_URL,
      token: process.env.NOVAMEM_SMOKE_TOKEN,
    })
);
await (process.argv[2] === "down" ? down(c) : up(c));
