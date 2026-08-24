/**
 * Detect which configured AI tools are present on the user's machine
 * by probing each tool's `detect[]` paths against the project root or
 * $HOME, depending on its scope.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { exists } from "./file-ops.js";
import type { ToolEntry } from "./tools.js";
import { TOOLS } from "./tools.js";

export interface DetectionContext {
  /** Project root for `scope: 'project'` tools — defaults to cwd. */
  projectRoot: string;
  /** Home directory for `scope: 'user'` tools — defaults to os.homedir(). */
  home: string;
}

export function defaultContext(): DetectionContext {
  return { projectRoot: process.cwd(), home: homedir() };
}

/** Returns the absolute base path for a tool, given the detection context. */
export function rootFor(tool: ToolEntry, ctx: DetectionContext): string {
  return tool.scope === "user" ? ctx.home : ctx.projectRoot;
}

/** Returns true if any of `tool.detect[]` exists under the tool's scope root. */
export async function isInstalled(
  tool: ToolEntry,
  ctx: DetectionContext
): Promise<boolean> {
  const root = rootFor(tool, ctx);
  for (const probe of tool.detect) {
    if (await exists(join(root, probe))) return true;
  }
  return false;
}

/** Detects every tool in the registry and returns those that look installed. */
export async function detectAll(
  ctx: DetectionContext = defaultContext()
): Promise<ToolEntry[]> {
  const out: ToolEntry[] = [];
  for (const tool of TOOLS) {
    if (await isInstalled(tool, ctx)) out.push(tool);
  }
  return out;
}
