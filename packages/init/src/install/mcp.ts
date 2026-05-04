/**
 * MCP installer — writes a `novamem` server entry into each MCP-capable
 * host's config file, idempotently merging with whatever the user already
 * has there. Supports the two on-disk formats we know: JSON (most hosts)
 * and TOML (Codex CLI).
 *
 * Transports:
 *   - sse:   { type: "sse", url, headers: { Authorization: "Bearer nm_..." } }
 *   - stdio: { command: "npx", args: ["@azrtydxb/novamem-mcp"], env: { ... } }
 */

import { join } from "node:path";
import {
  deepGet,
  deepSet,
  parseJsonLoose,
  parseTomlLoose,
  stringifyJson,
  stringifyToml,
} from "../merge.js";
import { readFileMaybe, writeFileEnsureDir } from "../file-ops.js";
import type { ToolEntry } from "../tools.js";
import { rootFor, type DetectionContext } from "../detect.js";

export interface McpInstallParams {
  baseUrl: string;
  bearer: string;
}

export interface McpInstallResult {
  toolId: string;
  /** Absolute path of the config file we wrote. */
  configPath: string;
  /** True if our entry was newly added or changed; false if already in sync. */
  changed: boolean;
  /** True if no write happened (dry-run, or no MCP adapter for the tool). */
  skipped: boolean;
  reason?: string;
}

/** Build the MCP server entry object from the params + adapter. */
export function buildMcpEntry(adapter: NonNullable<ToolEntry["mcp"]>, p: McpInstallParams): unknown {
  const transport = adapter.transport ?? "sse";
  if (transport === "sse") {
    return {
      type: "sse",
      url: trimTrailingSlash(p.baseUrl) + "/mcp/sse",
      headers: { Authorization: `Bearer ${p.bearer}` },
    };
  }
  // stdio fallback for hosts that need the npm shim
  return {
    command: "npx",
    args: ["-y", "@azrtydxb/novamem-mcp"],
    env: {
      NOVAMEM_BASE_URL: trimTrailingSlash(p.baseUrl),
      NOVAMEM_TOKEN: p.bearer,
    },
  };
}

/**
 * Install / update the MCP entry for a tool. Returns `skipped: true` if the
 * tool has no MCP adapter (skill-only host) or if `dryRun` is set.
 */
export async function installMcp(
  tool: ToolEntry,
  ctx: DetectionContext,
  params: McpInstallParams,
  opts: { dryRun?: boolean } = {},
): Promise<McpInstallResult> {
  if (!tool.mcp) {
    return {
      toolId: tool.id,
      configPath: "",
      changed: false,
      skipped: true,
      reason: "no MCP adapter for this tool",
    };
  }

  const configPath = join(rootFor(tool, ctx), tool.mcp.path);
  const rootKey = tool.mcp.rootKey ?? "mcpServers";
  const serverKey = tool.mcp.serverKey ?? "novamem";
  const entry = buildMcpEntry(tool.mcp, params);

  const raw = await readFileMaybe(configPath);
  const doc =
    tool.mcp.format === "toml" ? parseTomlLoose(raw) : parseJsonLoose(raw);

  // Idempotency check — if the existing entry already matches, no-op.
  const existing = deepGet(doc, [rootKey, serverKey]);
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { toolId: tool.id, configPath, changed: false, skipped: false };
  }

  deepSet(doc, [rootKey, serverKey], entry);

  if (opts.dryRun) {
    return { toolId: tool.id, configPath, changed: true, skipped: true, reason: "dry-run" };
  }

  const serialized =
    tool.mcp.format === "toml" ? stringifyToml(doc) : stringifyJson(doc);
  await writeFileEnsureDir(configPath, serialized);

  return { toolId: tool.id, configPath, changed: true, skipped: false };
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
