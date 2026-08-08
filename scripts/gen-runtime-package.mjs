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
import { dirname, join, resolve } from "node:path";

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

/** Read the version actually installed in the workspace for `name`.
 *
 *  This is the whole point of the exercise. The runtime stage installs
 *  with `npm install --no-package-lock`, which resolves declared ranges
 *  fresh against the registry — so the image could ship different
 *  versions from the ones CI tested, with nothing to catch it.
 *
 *  That is not hypothetical: `@qdrant/js-client-rest` was declared
 *  `^1.12.0`; the lockfile pinned 1.17.0 for tests while the image
 *  resolved 1.19.0, which had REMOVED the `search()` method the cold
 *  store called. Every vector search in the published image would have
 *  thrown, with a fully green test suite.
 *
 *  Resolving against the workspace's installed tree (which `pnpm install
 *  --frozen-lockfile` built from pnpm-lock.yaml) and writing exact pins
 *  makes "what we ship" equal "what we tested" for every direct
 *  dependency. Transitives are still resolved by npm, but the CVE floors
 *  below constrain the ones that matter. */
function resolveInstalledVersion(name, serverPkgPath) {
  const serverDir = dirname(resolve(serverPkgPath));
  const candidates = [
    join(serverDir, "node_modules", name, "package.json"),
    join(serverDir, "..", "..", "node_modules", name, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")).version;
    } catch {
      // try the next location
    }
  }
  return null;
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

// Pin every direct production dependency to the version the workspace
// lockfile resolved, so the image cannot drift from what CI tested.
const pinned = {};
const unresolved = [];
for (const [name, range] of Object.entries(server.dependencies ?? {})) {
  const version = resolveInstalledVersion(name, serverPath);
  if (version) {
    pinned[name] = version;
  } else {
    // Fall back to the declared range rather than failing the build; a
    // missing package here means the workspace install did not include
    // it, which npm will still resolve in the runtime stage.
    pinned[name] = range;
    unresolved.push(name);
  }
}
server.dependencies = pinned;
server.overrides = overrides;

writeFileSync(outPath, `${JSON.stringify(server, null, 2)}\n`);
console.log(
  `[gen-runtime-package] wrote ${outPath}: ` +
    `${Object.keys(pinned).length} dependencies pinned to lockfile-resolved versions, ` +
    `${Object.keys(overrides).length} npm overrides`,
);
if (unresolved.length > 0) {
  console.warn(
    `[gen-runtime-package] WARNING: could not resolve installed versions for ` +
      `${unresolved.join(", ")} — these fall back to their declared range and may ` +
      `differ in the image from what was tested.`,
  );
}
