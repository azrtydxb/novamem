// The shared behaviour suite (clients/contract/scenarios.json, ADR 0009).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import * as nm from "../src/index.js";
import { DISPATCH } from "./dispatch.js";

// Compiled into dist-test/test/, so clients/ is three levels up.
const CONTRACT = new URL("../../../contract/", import.meta.url);
const SCEN = JSON.parse(
  readFileSync(new URL("scenarios.json", CONTRACT), "utf8")
);
const TOKEN: string = SCEN.token;
let proc: ChildProcess;
let url = "";
let closed = "";

before(async () => {
  proc = spawn("sh", ["scenario-server.sh", "-scenarios", "scenarios.json"], {
    cwd: CONTRACT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line: string = await new Promise((res) =>
    createInterface({ input: proc.stdout! }).once("line", res)
  );
  const parts = line.split(" ");
  url = parts[1];
  closed = parts[2].split("=")[1];
});
after(() => {
  proc.kill();
});

function isEmpty(r: unknown): boolean {
  return (
    (Array.isArray(r) && r.length === 0) ||
    (typeof r === "object" &&
      r !== null &&
      Array.isArray((r as any).results) &&
      (r as any).results.length === 0)
  );
}

function classify(r: unknown, e: unknown): string {
  if (e === undefined) return isEmpty(r) ? "empty" : "ok";
  if (!(e instanceof nm.NovamemError)) throw e;
  if (e.canceled) return "canceled";
  if (e.unavailable) return "unavailable";
  if (e.notFound) return "not_found";
  return "error";
}

function subset(want: unknown, got: unknown, path = "$"): string {
  if (want !== null && typeof want === "object" && !Array.isArray(want)) {
    if (got === null || typeof got !== "object")
      return `${path}: want an object, got ${JSON.stringify(got)}`;
    for (const [k, v] of Object.entries(want)) {
      const d = subset(v, (got as any)[k], `${path}.${k}`);
      if (d) return d;
    }
    return "";
  }
  return JSON.stringify(want) === JSON.stringify(got)
    ? ""
    : `${path}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
}

// proved by: removing the degraded-empty check in Client.search fails
// search-degraded-empty-is-unavailable; removing the token redaction fails
// token-echoed-in-401-is-redacted.
for (const s of SCEN.scenarios) {
  test(s.id, async () => {
    const call = s.call;
    let r: unknown;
    let e: unknown;
    if (call.class === "ctor") {
      try {
        new nm.Client({
          baseUrl: call.args.baseUrl.replace("<server>", url),
          token: call.args.token,
        });
      } catch (err) {
        e = err;
      }
    } else {
      const baseUrl = JSON.stringify(s.respond).includes('"refused"')
        ? `http://127.0.0.1:${closed}/s/${s.id}`
        : `${url}/s/${s.id}`;
      const o = { baseUrl, token: TOKEN, timeoutMs: SCEN.timeoutMs };
      const clients = {
        Client: new nm.Client(o),
        Management: new nm.Management(o),
        Admin: new nm.Admin(o),
      };
      const ac = new AbortController();
      const timer = call.cancelAfterMs
        ? setTimeout(() => ac.abort(), call.cancelAfterMs)
        : undefined;
      try {
        r = await DISPATCH[call.method](clients, call.args, ac.signal);
      } catch (err) {
        e = err;
      } finally {
        clearTimeout(timer);
      }
    }
    const exp = s.expect;
    assert.equal(classify(r, e), exp.outcome, `${s.id}: ${String(e)}`);
    if (e instanceof nm.NovamemError) {
      assert.ok(!String(e).includes(TOKEN), "token leaked into String(err)");
      assert.ok(!inspect(e).includes(TOKEN), "token leaked into inspect(err)");
      assert.ok(
        !JSON.stringify(e).includes(TOKEN),
        "token leaked into JSON.stringify(err)"
      );
      if ("retryable" in exp) assert.equal(e.retryable, exp.retryable);
      if ("statusCode" in exp) assert.equal(e.statusCode, exp.statusCode);
      if ("code" in exp) assert.equal(e.code, exp.code);
    }
    if (e instanceof Error && "messageContains" in exp) {
      assert.ok(
        String(e).toLowerCase().includes(exp.messageContains.toLowerCase()),
        `message ${String(e)}`
      );
    }
    if ("result" in exp) assert.equal(subset(exp.result, r), "");
    if (call.class !== "ctor") {
      const v = await (await fetch(`${url}/_verdict/${s.id}`)).json();
      assert.deepEqual(v.mismatches, []);
      if (Array.isArray(s.expectRequest) && s.expectRequest.length === 0)
        assert.equal(v.requests, 0);
    }
  });
}
