#!/usr/bin/env node
/**
 * Build the runtime image's package.json.
 *
 * The production image installs a fresh, prod-only dependency tree with
 * plain `npm install` rather than reusing the workspace's pnpm store —
 * smaller image, smaller attack surface. That means two things have to be
 * fixed up:
 *
 *   1. devDependencies and scripts are dropped, so npm never sees
 *      `workspace:*` specifiers it can't resolve.
 *   2. npm doesn't read `pnpm.overrides`, so the CVE floors the workspace
 *      pins would silently not apply inside the image. This script
 *      translates them into npm's `overrides` field.
 *
 * The translation exists because the two tools spell the same idea
 * differently. pnpm supports a selector in the key — `"pkg@<1.2.3":
 * ">=1.2.3"` meaning "only override versions below 1.2.3" — while npm
 * keys on the bare package name. Dropping the selector is safe: the
 * target is a floor range (`>=x`), so a dependency that already resolves
 * above it is unaffected.
 *
 * Usage: node gen-runtime-package.mjs <root pkg> <server pkg> <out path>
 */

import { readFileSync, writeFileSync } from "node:fs";

const [rootPath, serverPath, outPath] = process.argv.slice(2);
if (!rootPath || !serverPath || !outPath) {
  console.error("usage: gen-runtime-package.mjs <root-package.json> <server-package.json> <out>");
  process.exit(2);
}

/** Overrides that only matter inside the image. npm's own bundled tree
 *  used to trip Trivy here; the npm CLI is deleted from the runtime layer
 *  now, but these are cheap to keep and guard against a base-image change
 *  that reintroduces them. */
const RUNTIME_ONLY_OVERRIDES = {
  picomatch: ">=4.0.4",
  underscore: ">=1.13.8",
};

/** `"pkg@<1.2.3"` → `"pkg"`; `"@scope/pkg@<1.2.3"` → `"@scope/pkg"`.
 *  Splits on the LAST `@` so scoped names survive. */
function stripSelector(key) {
  const at = key.lastIndexOf("@");
  if (at <= 0) return key;
  return key.slice(0, at);
}

const root = JSON.parse(readFileSync(rootPath, "utf8"));
const server = JSON.parse(readFileSync(serverPath, "utf8"));

const overrides = { ...RUNTIME_ONLY_OVERRIDES };
for (const [key, value] of Object.entries(root.pnpm?.overrides ?? {})) {
  const name = stripSelector(key);
  // If the same package appears under several selectors, keep the
  // highest floor so we never weaken a pin.
  const existing = overrides[name];
  overrides[name] = existing && existing > value ? existing : value;
}

delete server.devDependencies;
delete server.scripts;
server.overrides = overrides;

writeFileSync(outPath, `${JSON.stringify(server, null, 2)}\n`);
console.log(
  `[gen-runtime-package] wrote ${outPath} with ${Object.keys(overrides).length} npm overrides`,
);
