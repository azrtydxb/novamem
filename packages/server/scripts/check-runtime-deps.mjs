/** Asserts every bare import in the built output resolves to a production
 * dependency.
 *
 * This exists because a `pnpm add -D` on a package that main.ts imports at
 * startup produced a green CI and an image that could not boot: the runtime
 * install is production-only, so `@opentelemetry/sdk-node` was simply absent
 * and node threw ERR_MODULE_NOT_FOUND on the first import. Nothing caught it
 * — typecheck and tests both see devDependencies, and the docker build only
 * compiles, it never starts the process.
 *
 * A static scan is the right shape here rather than a boot smoke test: it
 * needs no database, no network and no ports, and it covers every module in
 * dist rather than only the paths a smoke test happens to reach.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const allowed = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".js") || full.endsWith(".mjs")) yield full;
  }
}

/** The package a bare specifier belongs to: "@scope/name" or "name". */
function packageOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const dist = join(pkgRoot, "dist");
let scanned = 0;
const violations = new Map();

for (const file of walk(dist)) {
  scanned++;
  const src = readFileSync(file, "utf8");
  // Anchored to the start of a line, because `from "..."` appears inside SQL
  // strings too ("... delete from \"table\"") and an unanchored match reads
  // those as module specifiers. Compiled output puts every static import on
  // its own line, so this loses nothing. `import(` is unambiguous and does
  // not need anchoring.
  const specs = [
    ...src.matchAll(/^\s*import\s[^;'"]*?\bfrom\s*["']([^"']+)["']/gm),
    ...src.matchAll(/^\s*export\s[^;'"]*?\bfrom\s*["']([^"']+)["']/gm),
    ...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);

  for (const spec of specs) {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) continue;
    const name = packageOf(spec);
    if (builtins.has(name) || builtins.has(spec) || allowed.has(name)) continue;
    if (!violations.has(name)) violations.set(name, new Set());
    violations.get(name).add(file.slice(pkgRoot.length + 1));
  }
}

if (violations.size > 0) {
  console.error(
    `\ncheck-runtime-deps: ${violations.size} package(s) imported by dist/ but not in "dependencies".\n` +
      `The production image installs dependencies only, so these fail at boot with\n` +
      `ERR_MODULE_NOT_FOUND even though typecheck and tests pass locally.\n`,
  );
  for (const [name, files] of [...violations].sort()) {
    console.error(`  ${name}`);
    for (const f of [...files].sort()) console.error(`      ${f}`);
  }
  console.error(`\nMove each to dependencies:  pnpm --filter novamem-server add <pkg>\n`);
  process.exit(1);
}

console.log(`check-runtime-deps: ok — ${scanned} built modules, all imports resolve to dependencies`);
