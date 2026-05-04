/**
 * Filesystem helpers — small wrappers that consolidate the edge cases we
 * need across installers (missing files, atomic writes, recursive copy
 * of the bundled skill assets, dry-run gating).
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/** Read a file as utf-8, or null if it doesn't exist. */
export async function readFileMaybe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Write a file utf-8, creating parent dirs as needed. */
export async function writeFileEnsureDir(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, "utf8");
}

/** Recursively copy a directory tree; idempotent (overwrites). */
export async function copyDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const ent of entries) {
    const src = join(from, ent.name);
    const dst = join(to, ent.name);
    if (ent.isDirectory()) {
      await copyDir(src, dst);
    } else if (ent.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}

/** Test whether a path exists (any kind of entry). */
export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
