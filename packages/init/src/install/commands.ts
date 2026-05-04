/**
 * Slash-command installer — copies the bundled command files (sourced from
 * `integrations/claude-code/commands/` at package build time) into each
 * host's commands directory, reformatted per the host's expected file
 * shape.
 *
 * Source format: YAML frontmatter + markdown body, the Claude Code shape.
 * Per-host adapters re-emit either the same shape (most hosts), a
 * `.prompt` flat file (Continue), a `.prompt.md` file (GitHub Copilot),
 * or a TOML file (Gemini CLI).
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyToml } from "../merge.js";
import type { ToolEntry, CommandAdapter } from "../tools.js";
import { rootFor, type DetectionContext } from "../detect.js";

/** Path to the bundled command files, resolved relative to this module. */
export function bundledCommandsPath(): string {
  // dist/install/commands.js → dist/assets/commands/
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "assets", "commands");
}

export interface CommandInstallResult {
  toolId: string;
  /** Files we wrote / would write. */
  filesWritten: string[];
  skipped: boolean;
  reason?: string;
}

interface ParsedCommand {
  /** Raw frontmatter YAML between the leading `---` lines. */
  frontmatter: Record<string, string>;
  /** Markdown body after the second `---`. */
  body: string;
}

/** Parse a Claude-Code-style command file: YAML frontmatter + body. */
export function parseCommandFile(raw: string): ParsedCommand {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return { frontmatter: {}, body: raw };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return { frontmatter: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const m = line.match(/^([a-z][\w-]*):\s*(.*)$/i);
    if (m) fm[m[1]!] = m[2]!.trim();
  }
  const body = lines.slice(close + 1).join("\n").replace(/^\n/, "");
  return { frontmatter: fm, body };
}

/** Render the parsed command in the target host's expected file format. */
export function renderCommand(cmd: ParsedCommand, format: CommandAdapter["format"]): string {
  switch (format) {
    case "claude-md":
    case "github-prompt-md": {
      // Same source format works as-is for Claude/Cursor/Kilo/OpenCode/RooCode/
      // Cline/Factory/Windsurf/Amazon-Q/Codex. GitHub Copilot's .prompt.md uses
      // identical YAML-frontmatter + markdown shape.
      const fm = renderFrontmatter(cmd.frontmatter);
      return `---\n${fm}---\n\n${cmd.body}`;
    }
    case "continue-prompt": {
      // Continue's `.prompt` files are plain markdown — no frontmatter.
      // Stash the description as the first paragraph so the user can see
      // what each prompt does.
      const desc = cmd.frontmatter.description;
      return desc ? `${desc}\n\n${cmd.body}` : cmd.body;
    }
    case "gemini-toml": {
      // Gemini CLI's commands are TOML files with a known schema. We map:
      //   description     → description
      //   argument-hint   → arguments[0].hint  (placeholder shape)
      //   body            → prompt
      const doc: Record<string, unknown> = { prompt: cmd.body.trim() };
      if (cmd.frontmatter.description) doc.description = cmd.frontmatter.description;
      return stringifyToml(doc);
    }
  }
}

function renderFrontmatter(fm: Record<string, string>): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}\n`)
    .join("");
}

/** Determine the destination filename for a single command. */
export function destFilename(srcName: string, adapter: CommandAdapter): string {
  const base = basename(srcName, ".md");
  const prefixed = adapter.prefix ? `${adapter.prefix}${base}` : base;
  switch (adapter.format) {
    case "claude-md":
      return `${prefixed}.md`;
    case "continue-prompt":
      return `${prefixed}.prompt`;
    case "github-prompt-md":
      return `${prefixed}.prompt.md`;
    case "gemini-toml":
      return `${prefixed}.toml`;
  }
}

/** Install slash commands for one tool. No-ops for tools without a command adapter. */
export async function installCommands(
  tool: ToolEntry,
  ctx: DetectionContext,
  opts: { dryRun?: boolean; sourceDir?: string } = {},
): Promise<CommandInstallResult> {
  if (!tool.commands) {
    return {
      toolId: tool.id,
      filesWritten: [],
      skipped: true,
      reason: "no command adapter for this tool",
    };
  }
  const sourceDir = opts.sourceDir ?? bundledCommandsPath();
  const adapter = tool.commands;
  const destDir = join(rootFor(tool, ctx), adapter.dir);

  const sourceFiles = (await readdir(sourceDir)).filter((f) => f.endsWith(".md"));
  if (sourceFiles.length === 0) {
    return {
      toolId: tool.id,
      filesWritten: [],
      skipped: true,
      reason: `no source command files at ${sourceDir}`,
    };
  }

  const writtenPaths: string[] = [];
  if (!opts.dryRun) await mkdir(destDir, { recursive: true });

  for (const srcName of sourceFiles) {
    const srcPath = join(sourceDir, srcName);
    const raw = await readFile(srcPath, "utf8");
    const parsed = parseCommandFile(raw);
    const out = renderCommand(parsed, adapter.format);
    const destPath = join(destDir, destFilename(srcName, adapter));
    if (!opts.dryRun) await writeFile(destPath, out, "utf8");
    writtenPaths.push(destPath);
  }

  return {
    toolId: tool.id,
    filesWritten: writtenPaths,
    skipped: opts.dryRun === true,
    reason: opts.dryRun ? "dry-run" : undefined,
  };
}
