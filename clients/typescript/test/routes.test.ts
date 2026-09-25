import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nm from "../src/index.js";

const ROUTES = JSON.parse(
  readFileSync(
    new URL("../../../contract/routes.json", import.meta.url),
    "utf8"
  )
);
const camel = (s: string) => s[0].toLowerCase() + s.slice(1);

// proved by: renaming Client.prototype.sessionRecap fails this test.
test("every routes.json method resolves", () => {
  for (const [key, r] of Object.entries<any>(ROUTES)) {
    for (const m of r.methods ?? []) {
      const [cls, meth] = m.name.split(".");
      assert.equal(
        typeof (nm as any)[cls].prototype[camel(meth)],
        "function",
        `${key} ${m.name}`
      );
    }
  }
});
