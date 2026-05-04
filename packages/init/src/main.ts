#!/usr/bin/env node
/**
 * @azertydxb/novamem-init — interactive installer.
 *
 * Flow:
 *   1. Prompt base URL (or accept --base-url). Probe /health.
 *   2. Either:
 *        - --token <nm_…>      → use that bearer
 *        - --email + --password → sign in, mint a fresh bearer
 *        - interactive          → prompt email + password, mint bearer
 *   3. Detect installed tools. Show a multi-select pre-checked with
 *      detected ones (or all in --all mode, or filtered by --tools).
 *   4. Apply skill + MCP + commands per tool (or just preview in --dry-run).
 *   5. Print a summary and per-host post-install hints.
 */

import { Command, Option } from "commander";
import { input, password as passwordPrompt, checkbox, confirm } from "@inquirer/prompts";
import { hostname } from "node:os";
import { TOOLS, findTool, type ToolEntry } from "./tools.js";
import { detectAll, defaultContext, isInstalled } from "./detect.js";
import { applyTools, type ToolResult } from "./run.js";
import { mintToken, probeHealth, signIn, AuthError } from "./auth.js";

interface CliOptions {
  baseUrl?: string;
  email?: string;
  password?: string;
  token?: string;
  tools?: string;
  all?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

const PKG_VERSION = "0.1.0";

export async function runCli(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("novamem-init")
    .description(
      "Sign in to a novamem server, mint a bearer, and configure every supported AI agent host (Claude Code, Cursor, Codex, Claude Desktop, Kilo Code, OpenCode, RooCode, Continue, Cline, Gemini CLI, GitHub Copilot, Amazon Q, Factory, Windsurf, …)",
    )
    .version(PKG_VERSION)
    .addOption(new Option("--base-url <url>", "novamem server URL").env("NOVAMEM_BASE_URL"))
    .addOption(new Option("--email <email>", "dashboard email (skip prompt)"))
    .addOption(new Option("--password <password>", "dashboard password (skip prompt — prefer NOVAMEM_PASSWORD env)").env("NOVAMEM_PASSWORD"))
    .addOption(new Option("--token <nm>", "use an existing nm_… bearer; skip sign-in").env("NOVAMEM_TOKEN"))
    .option("--tools <ids>", "comma-separated tool ids (default: detected ones)")
    .option("--all", "configure every tool in the registry, even undetected ones")
    .option("--yes, -y", "non-interactive: assume defaults, no confirmation prompt")
    .option("--dry-run", "preview file paths without writing");
  program.parse(argv);
  const opts = program.opts<CliOptions>();

  try {
    const baseUrl = await resolveBaseUrl(opts);
    const bearer = await resolveBearer(opts, baseUrl);
    const tools = await resolveTools(opts);
    if (tools.length === 0) {
      console.error("✗ No tools selected. Pass --all or --tools=<id,…> or run interactively.");
      return 1;
    }
    if (!opts.yes && !opts.dryRun) {
      console.log(`\nAbout to configure ${tools.length} tool${tools.length === 1 ? "" : "s"}: ${tools.map((t) => t.name).join(", ")}.`);
      const ok = await confirm({ message: "Proceed?", default: true });
      if (!ok) {
        console.log("Aborted.");
        return 1;
      }
    }
    const results = await applyTools(tools, {
      baseUrl,
      bearer,
      ctx: defaultContext(),
      dryRun: opts.dryRun ?? false,
    });
    printSummary(results, opts.dryRun ?? false);
    return 0;
  } catch (e) {
    if (e instanceof AuthError) {
      console.error(`✗ ${e.message}`);
      return 1;
    }
    if (e instanceof Error && (e as { name?: string }).name === "ExitPromptError") {
      console.log("\nAborted.");
      return 130;
    }
    console.error("✗", e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function resolveBaseUrl(opts: CliOptions): Promise<string> {
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    baseUrl = await input({
      message: "novamem server URL",
      default: "http://localhost:7778",
      validate: (v) => /^https?:\/\//.test(v) || "must start with http:// or https://",
    });
  }
  await probeHealth(baseUrl);
  console.log(`✓ Server reachable at ${baseUrl}`);
  return baseUrl;
}

async function resolveBearer(opts: CliOptions, baseUrl: string): Promise<string> {
  if (opts.token) {
    return opts.token;
  }
  const email = opts.email ?? (await input({
    message: "dashboard email",
    validate: (v) => v.includes("@") || "must be an email address",
  }));
  const pwd = opts.password ?? (await passwordPrompt({
    message: "dashboard password",
    mask: "•",
  }));
  console.log(`→ Signing in as ${email}…`);
  const cookie = await signIn({ baseUrl, email, password: pwd });
  console.log("✓ Signed in. Minting a bearer token…");
  const label = `novamem-init@${hostname()}`;
  const token = await mintToken({ baseUrl, sessionCookie: cookie, label });
  console.log(`✓ Minted token (label: ${label})`);
  return token;
}

async function resolveTools(opts: CliOptions): Promise<readonly ToolEntry[]> {
  if (opts.tools) {
    const ids = opts.tools.split(",").map((s) => s.trim()).filter(Boolean);
    const out: ToolEntry[] = [];
    for (const id of ids) {
      const t = findTool(id);
      if (!t) {
        throw new Error(`unknown tool id: ${id}. Run with --help to list valid ids.`);
      }
      out.push(t);
    }
    return out;
  }
  if (opts.all) {
    return TOOLS;
  }
  const ctx = defaultContext();
  const detected = await detectAll(ctx);
  if (opts.yes) {
    return detected;
  }
  // Interactive multi-select with detected tools pre-checked.
  const choices = await Promise.all(TOOLS.map(async (tool) => {
    const installed = await isInstalled(tool, ctx);
    return {
      name: `${tool.name}${installed ? " (detected)" : ""}`,
      value: tool.id,
      checked: installed,
    };
  }));
  const selected = await checkbox({
    message: "Configure which AI tools?",
    choices,
    pageSize: 20,
  });
  return selected.map((id) => findTool(id)!);
}

function printSummary(results: ToolResult[], dryRun: boolean): void {
  console.log(`\n${dryRun ? "Would configure" : "Configured"} ${results.length} tool${results.length === 1 ? "" : "s"}:\n`);
  for (const r of results) {
    const lines: string[] = [];
    if (r.skill.written || dryRun) {
      lines.push(`  skill   → ${r.skill.destination}`);
    }
    if (r.mcp.changed) {
      lines.push(`  mcp     → ${r.mcp.configPath}`);
    } else if (!r.mcp.skipped) {
      lines.push(`  mcp     · already in sync`);
    }
    if (r.commands.filesWritten.length > 0) {
      lines.push(`  cmd     → ${r.commands.filesWritten.length} file${r.commands.filesWritten.length === 1 ? "" : "s"} in ${r.tool.commands?.dir}`);
    }
    if (lines.length === 0) lines.push("  (no-op)");
    console.log(`${r.tool.name}`);
    for (const l of lines) console.log(l);
    if (r.tool.postInstallHint) {
      console.log(`  ⓘ ${r.tool.postInstallHint}`);
    }
    console.log();
  }
  if (dryRun) console.log("Dry run — no files were written.");
}

// CLI entrypoint. The `dist/main.js` shebang line + this guard let us
// also import { runCli } from tests without launching the program.
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv).then((code) => process.exit(code));
}
