#!/usr/bin/env node
/**
 * Copy the built admin UI into the server's dist tree so @fastify/static
 * can serve it under /admin/. Run as a server-build post step. Fails fast
 * if the admin-ui build hasn't run — production images and dev runs both
 * need the assets for /admin to work.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../admin-ui/dist");
const dst = resolve(here, "../dist/admin/ui");

if (!existsSync(src)) {
  console.error(`[build:assets] missing ${src}`);
  console.error(`               run \`pnpm --filter @azrtydxb/novamem-admin-ui build\` first,`);
  console.error(`               or \`pnpm -r build\` from the repo root.`);
  process.exit(1);
}

if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`[build:assets] copied admin-ui -> ${dst}`);
