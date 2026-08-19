#!/usr/bin/env node
/**
 * @azrtydxb/novamem-init — interactive installer.
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
import {
  input,
  password as passwordPrompt,
  checkbox,
  confirm,
} from "@inquirer/prompts";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
// Note: readFileSync is also imported below for PKG_VERSION; keeping a
// single import reads cleaner if both end up needed long-term.
import { hostname } from "node:os";
import { TOOLS, findTool, type ToolEntry } from "./tools.js";
import { detectAll, defaultContext, isInstalled } from "./detect.js";
import { applyTools, type ToolResult } from "./run.js";
import { mintToken, probeHealth, signIn, AuthError } from "./auth.js";
import { loadState, saveState } from "./state.js";
import { verifyShim } from "./install/mcp.js";

interface CliOptions {
  baseUrl?: string;
  email?: string;
  password?: string;
  token?: string;
  tools?: string;
  all?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  skipShimCheck?: boolean;
}

// Read the published version from the bundled package.json so commander's
// --version stays in sync with what's on npm without a manual bump every
// release. The runtime tarball ships package.json next to dist/.
import { readFileSync } from "node:fs";
const PKG_VERSION: string = (() => {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    return JSON.parse(readFileSync(pkgUrl, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export async function runCli(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("novamem-init")
    .description(
      "Sign in to a novamem server, mint a bearer, and configure every supported AI agent host (Claude Code, Cursor, Codex, Claude Desktop, Kilo Code, OpenCode, RooCode, Continue, Cline, Gemini CLI, GitHub Copilot, Amazon Q, Factory, Windsurf, …)"
    )
    .version(PKG_VERSION)
    .addOption(
      new Option("--base-url <url>", "novamem server URL").env(
        "NOVAMEM_BASE_URL"
      )
    )
    .addOption(new Option("--email <email>", "dashboard email (skip prompt)"))
    .addOption(
      new Option(
        "--password <password>",
        "dashboard password (skip prompt — prefer NOVAMEM_PASSWORD env)"
      ).env("NOVAMEM_PASSWORD")
    )
    .addOption(
      new Option(
        "--token <nm>",
        "use an existing nm_… bearer; skip sign-in"
      ).env("NOVAMEM_TOKEN")
    )
    .option(
      "--tools <ids>",
      "comma-separated tool ids (default: detected ones)"
    )
    .option(
      "--all",
      "configure every tool in the registry, even undetected ones"
    )
    .option(
      "--yes, -y",
      "non-interactive: assume defaults, no confirmation prompt"
    )
    .option("--dry-run", "preview file paths without writing")
    .option(
      "--skip-shim-check",
      "skip the npm pre-flight that verifies @azrtydxb/novamem-mcp is fetchable + runnable before writing stdio configs"
    );
  program.parse(argv);
  const opts = program.opts<CliOptions>();

  try {
    // Re-runs feel less repetitive when the previous answer pre-fills.
    // Tokens are NEVER cached — always re-mint or accept --token.
    const state = loadState();
    const baseUrl = await resolveBaseUrl(opts, state.lastBaseUrl);
    const { bearer, email } = await resolveBearer(
      opts,
      baseUrl,
      state.lastEmail
    );
    const tools = await resolveTools(opts);
    if (tools.length === 0) {
      console.error(
        "✗ No tools selected. Pass --all or --tools=<id,…> or run interactively."
      );
      return 1;
    }
    // Pre-flight: if any selected tool uses our stdio shim, verify the
    // pinned shim version is fetchable + runnable BEFORE we write a
    // config that points at it. Avoids the silent "Server disconnected"
    // class of bug where the spawn dies because npm can't resolve a
    // bad workspace:* (or any other) shim publish issue.
    const needsShim = tools.some(
      (t) => (t.mcp?.transport ?? "sse") === "stdio"
    );
    if (needsShim && !opts.skipShimCheck && !opts.dryRun) {
      console.log(
        `→ Pre-flight: verifying @azrtydxb/novamem-mcp@${PKG_VERSION} is installable + runnable…`
      );
      const v = await verifyShim(PKG_VERSION);
      if (!v.ok) {
        console.error(
          `✗ Pre-flight failed: ${v.reason}\n  Refusing to write a stdio config that would silently fail.\n  Pass --skip-shim-check to override at your own risk.`
        );
        return 1;
      }
      console.log(`✓ Shim ready.`);
    }
    if (!opts.yes && !opts.dryRun) {
      console.log(
        `\nAbout to configure ${tools.length} tool${
          tools.length === 1 ? "" : "s"
        }: ${tools.map((t) => t.name).join(", ")}.`
      );
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
      shimVersion: PKG_VERSION,
    });
    printSummary(results, opts.dryRun ?? false);
    if (!opts.dryRun) {
      // Persist what worked so the next run pre-fills it.
      saveState({ lastBaseUrl: baseUrl, lastEmail: email });
    }
    return 0;
  } catch (e) {
    if (e instanceof AuthError) {
      console.error(`✗ ${e.message}`);
      return 1;
    }
    if (
      e instanceof Error &&
      (e as { name?: string }).name === "ExitPromptError"
    ) {
      console.log("\nAborted.");
      return 130;
    }
    console.error("✗", e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function resolveBaseUrl(
  opts: CliOptions,
  lastBaseUrl?: string
): Promise<string> {
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    // Prefer the last successful base URL over the local-dev default
    // when re-running on a fresh terminal.
    baseUrl = await input({
      message: "novamem server URL",
      default: lastBaseUrl ?? "http://localhost:7778",
      validate: (v) =>
        /^https?:\/\//.test(v) || "must start with http:// or https://",
    });
  }
  await probeHealth(baseUrl);
  console.log(`✓ Server reachable at ${baseUrl}`);
  return baseUrl;
}

async function resolveBearer(
  opts: CliOptions,
  baseUrl: string,
  lastEmail?: string
): Promise<{ bearer: string; email?: string }> {
  if (opts.token) {
    return { bearer: opts.token };
  }
  const email =
    opts.email ??
    (await input({
      message: "dashboard email",
      default: lastEmail,
      validate: (v) => v.includes("@") || "must be an email address",
    }));
  const pwd =
    opts.password ??
    (await passwordPrompt({
      message: "dashboard password",
      mask: "•",
    }));
  console.log(`→ Signing in as ${email}…`);
  const cookie = await signIn({ baseUrl, email, password: pwd });
  console.log("✓ Signed in. Minting a bearer token…");
  const label = `novamem-init@${hostname()}`;
  const token = await mintToken({ baseUrl, sessionCookie: cookie, label });
  console.log(`✓ Minted token (label: ${label})`);
  return { bearer: token, email };
}

async function resolveTools(opts: CliOptions): Promise<readonly ToolEntry[]> {
  if (opts.tools) {
    const ids = opts.tools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const out: ToolEntry[] = [];
    for (const id of ids) {
      const t = findTool(id);
      if (!t) {
        throw new Error(
          `unknown tool id: ${id}. Run with --help to list valid ids.`
        );
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
  const choices = await Promise.all(
    TOOLS.map(async (tool) => {
      const installed = await isInstalled(tool, ctx);
      return {
        name: `${tool.name}${installed ? " (detected)" : ""}`,
        value: tool.id,
        checked: installed,
      };
    })
  );
  const selected = await checkbox({
    message: "Configure which AI tools?",
    choices,
    pageSize: 20,
  });
  return selected.map((id) => findTool(id)!);
}

function printSummary(results: ToolResult[], dryRun: boolean): void {
  console.log(
    `\n${dryRun ? "Would configure" : "Configured"} ${results.length} tool${
      results.length === 1 ? "" : "s"
    }:\n`
  );
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
      lines.push(
        `  cmd     → ${r.commands.filesWritten.length} file${
          r.commands.filesWritten.length === 1 ? "" : "s"
        } in ${r.tool.commands?.dir}`
      );
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
// `process.argv[1]` is whatever path Node was launched with — when npm
// links bin scripts (npx / global install / project node_modules), that
// path is a symlink to this file. Compare *resolved* paths so the
// symlink-based invocation runs the CLI; otherwise `npx
// @azrtydxb/novamem-init` exits silently with no output (the symbolic
// equality check the original guard used never matched the symlink).
const here = fileURLToPath(import.meta.url);
let invokedAsCli = false;
try {
  invokedAsCli = process.argv[1]
    ? realpathSync(process.argv[1]) === here
    : false;
} catch {
  // If realpath fails (e.g. argv[1] doesn't exist), don't auto-run.
}
if (invokedAsCli) {
  runCli(process.argv).then((code) => process.exit(code));
}
