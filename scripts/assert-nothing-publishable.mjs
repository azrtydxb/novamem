#!/usr/bin/env node
// npm publishing is retired: the three publishable packages (client, mcp,
// init) were superseded by Go binaries and deleted, and every remaining
// workspace package is private. This asserts it stays that way — if a
// publishable package reappears, either it is private by mistake or the
// release workflow needs restoring, and silently shipping nothing is the
// worst of the three outcomes.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = "packages";
const publishable = [];
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = join(dir, entry.name, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.private !== true) publishable.push(pkg.name ?? entry.name);
}

if (publishable.length > 0) {
  console.error(
    `Unexpected publishable package(s): ${publishable.join(", ")}\n` +
      "npm publishing was retired — mark it private, or restore the release workflow."
  );
  process.exit(1);
}
console.log("No publishable packages: npm publishing is retired.");
