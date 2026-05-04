// Copies the skill bundle and slash commands from the monorepo into the
// package's dist/ at build time so the published tarball is self-contained.
// At runtime the CLI reads from dist/assets/.

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const distAssets = resolve(here, "..", "dist", "assets");

const sources = [
  { from: resolve(repoRoot, "skills", "novamem"), to: resolve(distAssets, "skill") },
  {
    from: resolve(repoRoot, "integrations", "claude-code", "commands"),
    to: resolve(distAssets, "commands"),
  },
];

if (existsSync(distAssets)) await rm(distAssets, { recursive: true, force: true });
await mkdir(distAssets, { recursive: true });

for (const { from, to } of sources) {
  if (!existsSync(from)) {
    console.error(`[copy-assets] missing source: ${from}`);
    process.exit(1);
  }
  await cp(from, to, { recursive: true });
  console.log(`[copy-assets] ${from.replace(repoRoot + "/", "")} → ${to.replace(repoRoot + "/", "")}`);
}
