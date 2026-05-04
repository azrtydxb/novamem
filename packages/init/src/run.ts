/**
 * Run orchestrator — given a chosen list of tools and the resolved
 * params (baseUrl, bearer), apply skill + MCP + commands to each, in
 * dependency order, collecting per-tool results.
 *
 * Pure I/O; no prompts. The CLI layer wraps this with @inquirer/prompts
 * and pretty output.
 */

import type { ToolEntry } from "./tools.js";
import type { DetectionContext } from "./detect.js";
import { installSkill, type SkillInstallResult } from "./install/skill.js";
import { installMcp, type McpInstallResult } from "./install/mcp.js";
import { installCommands, type CommandInstallResult } from "./install/commands.js";

export interface RunParams {
  baseUrl: string;
  bearer: string;
  ctx: DetectionContext;
  dryRun?: boolean;
}

export interface ToolResult {
  tool: ToolEntry;
  skill: SkillInstallResult;
  mcp: McpInstallResult;
  commands: CommandInstallResult;
}

export async function applyTools(
  tools: readonly ToolEntry[],
  params: RunParams,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const tool of tools) {
    const skill = await installSkill(tool, params.ctx, { dryRun: params.dryRun });
    const mcp = await installMcp(
      tool,
      params.ctx,
      { baseUrl: params.baseUrl, bearer: params.bearer },
      { dryRun: params.dryRun },
    );
    const commands = await installCommands(tool, params.ctx, { dryRun: params.dryRun });
    results.push({ tool, skill, mcp, commands });
  }
  return results;
}
