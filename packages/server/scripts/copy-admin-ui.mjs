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

// drizzle-kit migrations — needed at runtime for migrate() in
// WarmStore.initialize(). tsc doesn't copy non-.ts files into dist; do it
// here. The migration files (and the meta/_journal.json drizzle uses for
// ordering) sit next to the compiled warm-store output.
const migrationsSrc = resolve(here, "../src/warm-store/migrations");
const migrationsDst = resolve(here, "../dist/warm-store/migrations");
if (existsSync(migrationsSrc)) {
  if (existsSync(migrationsDst)) rmSync(migrationsDst, { recursive: true, force: true });
  mkdirSync(migrationsDst, { recursive: true });
  cpSync(migrationsSrc, migrationsDst, { recursive: true });
  console.log(`[build:assets] copied migrations -> ${migrationsDst}`);
} else {
  console.error(`[build:assets] missing ${migrationsSrc}`);
  console.error(`               run \`pnpm --filter @azrtydxb/novamem-server db:generate\` first.`);
  process.exit(1);
}
