#!/usr/bin/env node
// Release preflight — manual pre-tag safety net. See issue #74.
//
// Verifies, in order:
//   1. All publishable packages share the canonical version from root
//      package.json. Private packages (server, admin-ui) are skipped.
//   2. CHANGELOG.md has a non-empty `## [X.Y.Z]` section for the
//      canonical version.
//   3. docs/api/openapi.json is fresh — `pnpm docs:api` regenerates it
//      and the working tree must stay clean.
//   4. Working tree stays clean after `pnpm -r build`.
//
// Exits non-zero with an explanation when any check fails.
//
// This script is intentionally NOT wired into ci.yml — it's a manual
// pre-tag step. Recommend invoking from release.yml in a follow-up.

import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const failures = [];

function fail(msg) {
  failures.push(msg);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function gitStatusPorcelain() {
  return sh("git", ["status", "--porcelain"]).trim();
}

async function readJson(rel) {
  return JSON.parse(await readFile(join(ROOT, rel), "utf8"));
}

// ── 1. Aligned versions ───────────────────────────────────────────────
async function checkVersions() {
  const root = await readJson("package.json");
  const canonical = root.version;
  if (!canonical || !/^\d+\.\d+\.\d+/.test(canonical)) {
    fail(`root package.json has no semver version (got: ${canonical})`);
    return null;
  }
  const pkgsDir = join(ROOT, "packages");
  let entries = [];
  try {
    entries = await readdir(pkgsDir, { withFileTypes: true });
  } catch {
    fail("packages/ directory missing");
    return canonical;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pj = `packages/${e.name}/package.json`;
    let pkg;
    try {
      pkg = await readJson(pj);
    } catch {
      continue;
    }
    if (pkg.private === true) continue; // skip private (server, admin-ui)
    if (pkg.version !== canonical) {
      fail(`${pj}: version ${pkg.version} != canonical ${canonical}`);
    }
  }
  return canonical;
}

// ── 2. CHANGELOG entry ────────────────────────────────────────────────
async function checkChangelog(canonical) {
  if (!canonical) return;
  const text = await readFile(join(ROOT, "CHANGELOG.md"), "utf8").catch(() => null);
  if (!text) {
    fail("CHANGELOG.md missing");
    return;
  }
  const lines = text.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s*\\[${canonical.replace(/\./g, "\\.")}\\]`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    fail(`CHANGELOG.md: no \`## [${canonical}]\` section`);
    return;
  }
  // Find next ## heading after start.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).filter((l) => l.trim().length > 0);
  if (body.length === 0) {
    fail(`CHANGELOG.md: \`## [${canonical}]\` section is empty`);
  }
}

// ── 3. OpenAPI freshness ──────────────────────────────────────────────
function checkOpenApiFresh() {
  const before = gitStatusPorcelain();
  if (before.length > 0) {
    fail(`working tree dirty before openapi check:\n${before}`);
    return;
  }
  try {
    sh("pnpm", ["docs:api"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    fail(`pnpm docs:api failed: ${err.message}`);
    return;
  }
  const after = gitStatusPorcelain();
  if (after.length > 0) {
    fail(`docs/api/openapi.json (or related) is stale — \`pnpm docs:api\` produced changes:\n${after}`);
  }
}

// ── 4. Build leaves tree clean ────────────────────────────────────────
function checkBuildClean() {
  try {
    sh("pnpm", ["-r", "build"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    fail(`pnpm -r build failed: ${err.message}`);
    return;
  }
  const after = gitStatusPorcelain();
  if (after.length > 0) {
    fail(`working tree dirty after \`pnpm -r build\`:\n${after}`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────
async function main() {
  console.log("release-preflight: checking versions…");
  const canonical = await checkVersions();
  console.log(`release-preflight: canonical version = ${canonical}`);

  console.log("release-preflight: checking CHANGELOG…");
  await checkChangelog(canonical);

  console.log("release-preflight: regenerating OpenAPI…");
  checkOpenApiFresh();

  console.log("release-preflight: running -r build…");
  checkBuildClean();

  if (failures.length > 0) {
    console.error(`\nrelease-preflight: ${failures.length} failure(s):\n`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("\nRun before tag/release.");
    process.exit(1);
  }
  console.log("\nrelease-preflight: OK. Run before tag/release.");
}

main().catch((err) => {
  console.error("release-preflight: crashed:", err);
  process.exit(2);
});
