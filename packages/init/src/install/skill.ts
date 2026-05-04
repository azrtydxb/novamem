/**
 * Skill installer — uniform across every tool in the registry.
 *
 * The bundled skill at `dist/assets/skill/` (copied at build time from the
 * monorepo's `skills/novamem/`) is recursively copied into the host's
 * `<skillsBase>/skills/novamem/`. Idempotent: re-running overwrites with
 * the latest content.
 */

import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDir, exists } from "../file-ops.js";
import type { ToolEntry } from "../tools.js";
import { rootFor, type DetectionContext } from "../detect.js";

/** Path to the bundled skill assets, resolved relative to this module. */
export function bundledSkillPath(): string {
  // dist/install/skill.js → dist/assets/skill/
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "assets", "skill");
}

export interface SkillInstallResult {
  toolId: string;
  destination: string;
  written: boolean;
}

/**
 * Install the skill bundle for a single tool. Returns the destination path
 * and whether anything was actually written (false in dry-run mode).
 */
export async function installSkill(
  tool: ToolEntry,
  ctx: DetectionContext,
  opts: { dryRun?: boolean; sourceDir?: string } = {},
): Promise<SkillInstallResult> {
  const source = opts.sourceDir ?? bundledSkillPath();
  if (!(await exists(source))) {
    throw new Error(`bundled skill source not found at ${source} (run \`pnpm build\` first)`);
  }
  const destination = join(rootFor(tool, ctx), tool.skillsBase, "skills", "novamem");
  if (opts.dryRun) {
    return { toolId: tool.id, destination, written: false };
  }
  await copyDir(source, destination);
  return { toolId: tool.id, destination, written: true };
}
