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
  /** The version of `@azrtydxb/novamem-mcp` to pin in stdio entries.
   *  Should match this `init` package's version so the two always ship
   *  together — `.changeset/config.json` lists `novamem-init` and
   *  `novamem-mcp` in `linked`, which makes a bump on either trigger
   *  the same bump on the other. Defaults to a floating "latest" via
   *  plain package name when unset (legacy callers; new code should
   *  always pass an explicit version). */
  shimVersion?: string;
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
  // stdio fallback for hosts that need the npm shim. Pin the shim
  // version to this init's version so a v1.1.3 init doesn't accidentally
  // pull a v1.1.5 shim with a different protocol, and so that broken
  // shim versions on npm (rare — see the workspace:* republish saga)
  // can't be picked up via "latest" floating.
  const spec = p.shimVersion
    ? `@azrtydxb/novamem-mcp@${p.shimVersion}`
    : "@azrtydxb/novamem-mcp";
  const envKey = adapter.stdioEnvKey ?? "env";
  const entry: Record<string, unknown> = {
    command: "npx",
    args: ["-y", spec],
    [envKey]: {
      NOVAMEM_BASE_URL: trimTrailingSlash(p.baseUrl),
      NOVAMEM_TOKEN: p.bearer,
    },
  };
  // Hosts like OpenCode require an explicit `type: "local"` to identify
  // stdio servers. Inject when the adapter declares it; omit otherwise
  // (Claude Desktop / Codex parse fine without it).
  if (adapter.stdioTypeField) entry.type = adapter.stdioTypeField;
  return entry;
}

/**
 * Pure helper: scan parsed `npm view <spec> dependencies --json` output
 * for the `workspace:` protocol that npm/npx can't resolve. Returns the
 * first offending entry, or null if everything looks clean. Exported
 * for unit testing.
 */
export function findWorkspaceDep(
  raw: unknown,
): { name: string; value: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.startsWith("workspace:")) {
      return { name, value };
    }
  }
  return null;
}

/**
 * Verify the npm-published shim at `version` is installable + runnable
 * before we write a config that points at it. Catches the bug class
 * that produced the silent v0.1.0–1.1.2 outage where every published
 * shim had `workspace:*` deps that npm/npx couldn't resolve, leaving
 * Claude Desktop showing "Server disconnected" without explanation.
 *
 * Strategy:
 *   1. `npm view @azrtydxb/novamem-mcp@<v> dependencies` — assert that
 *      no value is exactly `workspace:*` or `workspace:^` etc. Fast,
 *      catches the specific bug.
 *   2. `npx -y @azrtydxb/novamem-mcp@<v>` with stdin closed and a
 *      short timeout — the shim should start, send a stdio-MCP
 *      protocol response (or at minimum exit cleanly), not crash.
 *      Catches anything else (missing bin shebang, runtime crash,
 *      wrong export, etc.).
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on failure.
 * Caller decides whether to abort, warn, or proceed.
 */
export interface ShimVerification {
  ok: boolean;
  reason?: string;
}
export async function verifyShim(version: string, opts: { timeoutMs?: number } = {}): Promise<ShimVerification> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const spec = `@azrtydxb/novamem-mcp@${version}`;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // 1. Static check: are deps concrete?
  try {
    const { stdout } = await exec("npm", ["view", spec, "dependencies", "--json"], {
      timeout: timeoutMs,
    });
    // `npm view` may print nothing (no deps), `null`, an array (multiple
    // versions matched), or an object {name: spec}. Only the object case
    // has fields to inspect — anything else is "no workspace: deps to
    // worry about" and we move on to the runtime check.
    const trimmed = stdout.toString().trim();
    if (trimmed) {
      const parsed: unknown = JSON.parse(trimmed);
      const offender = findWorkspaceDep(parsed);
      if (offender) {
        return {
          ok: false,
          reason: `published tarball has \`${offender.name}: ${offender.value}\` — npm/npx can't resolve workspace: protocol. The shim publish pipeline is broken.`,
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: `couldn't fetch ${spec} metadata from npm: ${(err as Error).message}`,
    };
  }

  // 2. Runtime check: spawn it and confirm it doesn't crash on startup.
  // The shim is a stdio MCP server — closing stdin makes it exit cleanly.
  const { spawn } = await import("node:child_process");
  const reason = await new Promise<string | null>((resolve) => {
    const child = spawn("npx", ["-y", spec], {
      env: {
        ...process.env,
        // Bogus values are fine — we're only checking it starts; any
        // tool call would fail auth which is expected in a smoke test.
        NOVAMEM_BASE_URL: "http://127.0.0.1:0",
        NOVAMEM_TOKEN: "smoke",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    const timer = setTimeout(() => {
      // No crash within the timeout means the shim is in its read loop
      // waiting for stdin — that's the desired healthy state.
      child.kill("SIGTERM");
      resolve(null);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`spawn failed: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      // SIGTERM = we killed it after the healthy timeout. Anything else
      // before timeout means it crashed before reaching the read loop.
      if (signal === "SIGTERM") return resolve(null);
      if (code === 0) return resolve(null); // clean exit on EOF, also fine
      resolve(`exit code ${code}; stderr: ${stderr.slice(0, 200).trim()}`);
    });
    child.stdin.end();
  });
  if (reason) return { ok: false, reason: `${spec} crashed on startup: ${reason}` };

  return { ok: true };
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
