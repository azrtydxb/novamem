import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, findTool } from "../src/tools.js";
import type { ToolEntry } from "../src/tools.js";
import type { DetectionContext } from "../src/detect.js";
import { installSkill } from "../src/install/skill.js";
import { installMcp, buildMcpEntry } from "../src/install/mcp.js";
import {
  installCommands,
  parseCommandFile,
  renderCommand,
  destFilename,
} from "../src/install/commands.js";

let tmpRoot: string;
let ctx: DetectionContext;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "novamem-init-test-"));
  ctx = { projectRoot: join(tmpRoot, "project"), home: join(tmpRoot, "home") };
  await mkdir(ctx.projectRoot, { recursive: true });
  await mkdir(ctx.home, { recursive: true });
});

async function makeFakeSkillSource(): Promise<string> {
  const dir = join(tmpRoot, "src-skill");
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "---\nname: novamem\ndescription: x\n---\n", "utf8");
  await writeFile(join(dir, "references", "search.md"), "# search ref\n", "utf8");
  return dir;
}

async function makeFakeCommandSource(): Promise<string> {
  const dir = join(tmpRoot, "src-cmd");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "remember.md"),
    "---\ndescription: Save a memory\nargument-hint: <content>\nallowed-tools: mcp__novamem__memory_remember\n---\n\nBody for remember.\n$ARGUMENTS",
    "utf8",
  );
  await writeFile(
    join(dir, "recall.md"),
    "---\ndescription: Recall memories\n---\n\nBody for recall.",
    "utf8",
  );
  return dir;
}

describe("installSkill", () => {
  it("copies the bundle into <root>/<skillsBase>/skills/novamem/", async () => {
    const source = await makeFakeSkillSource();
    const tool = findTool("claude-code")!;
    const r = await installSkill(tool, ctx, { sourceDir: source });
    expect(r.written).toBe(true);
    expect(r.destination).toBe(join(ctx.projectRoot, ".claude", "skills", "novamem"));
    expect(await readFile(join(r.destination, "SKILL.md"), "utf8")).toContain("name: novamem");
    expect(await readFile(join(r.destination, "references", "search.md"), "utf8")).toContain("# search ref");
  });
  it("uses home for user-scoped tools", async () => {
    const source = await makeFakeSkillSource();
    const tool = findTool("claude-desktop")!;
    const r = await installSkill(tool, ctx, { sourceDir: source });
    expect(r.destination).toBe(join(ctx.home, ".claude", "skills", "novamem"));
  });
  it("dry-run does not write files", async () => {
    const source = await makeFakeSkillSource();
    const tool = findTool("claude-code")!;
    const r = await installSkill(tool, ctx, { sourceDir: source, dryRun: true });
    expect(r.written).toBe(false);
    await expect(readFile(join(r.destination, "SKILL.md"), "utf8")).rejects.toThrow();
  });
});

describe("installMcp", () => {
  it("writes a fresh JSON config when none exists", async () => {
    const tool = findTool("claude-code")!;
    const r = await installMcp(tool, ctx, { baseUrl: "http://x:7778", bearer: "nm_t" });
    expect(r.changed).toBe(true);
    const written = JSON.parse(await readFile(r.configPath, "utf8")) as Record<string, unknown>;
    const entry = (written.mcpServers as Record<string, unknown>).novamem as Record<string, unknown>;
    expect(entry.type).toBe("sse");
    expect(entry.url).toBe("http://x:7778/mcp/sse");
    expect((entry.headers as Record<string, string>).Authorization).toBe("Bearer nm_t");
  });
  it("merges into an existing config without clobbering siblings", async () => {
    const tool = findTool("claude-code")!;
    const path = join(ctx.projectRoot, tool.mcp!.path);
    await mkdir(join(ctx.projectRoot), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { existing: { type: "sse", url: "u" } }, otherTopLevel: 1 }),
      "utf8",
    );
    await installMcp(tool, ctx, { baseUrl: "http://x:7778", bearer: "nm_t" });
    const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const servers = written.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["existing", "novamem"]);
    expect(written.otherTopLevel).toBe(1);
  });
  it("is idempotent when the entry already matches", async () => {
    const tool = findTool("claude-code")!;
    const a = await installMcp(tool, ctx, { baseUrl: "http://x:7778", bearer: "nm_t" });
    expect(a.changed).toBe(true);
    const b = await installMcp(tool, ctx, { baseUrl: "http://x:7778", bearer: "nm_t" });
    expect(b.changed).toBe(false);
  });
  it("writes TOML for Codex with mcp_servers root key", async () => {
    const tool = findTool("codex")!;
    const r = await installMcp(tool, ctx, { baseUrl: "http://x:7778", bearer: "nm_t" });
    expect(r.changed).toBe(true);
    expect(r.configPath.endsWith("config.toml")).toBe(true);
    const raw = await readFile(r.configPath, "utf8");
    expect(raw).toContain("[mcp_servers.novamem]");
    expect(raw).toContain('url = "http://x:7778/mcp/sse"');
  });
  it("skips tools with no MCP adapter", async () => {
    const tool = findTool("trae")!;
    const r = await installMcp(tool, ctx, { baseUrl: "http://x:7778", bearer: "nm_t" });
    expect(r.skipped).toBe(true);
    expect(r.changed).toBe(false);
  });
  it("dry-run does not write files", async () => {
    const tool = findTool("claude-code")!;
    const r = await installMcp(
      tool,
      ctx,
      { baseUrl: "http://x:7778", bearer: "nm_t" },
      { dryRun: true },
    );
    expect(r.skipped).toBe(true);
    expect(r.changed).toBe(true); // would have changed
    await expect(readFile(r.configPath, "utf8")).rejects.toThrow();
  });
});

describe("buildMcpEntry", () => {
  it("produces the SSE shape by default", () => {
    const e = buildMcpEntry({ path: "x", format: "json" }, { baseUrl: "http://h:7778", bearer: "tok" }) as Record<string, unknown>;
    expect(e.type).toBe("sse");
    expect(e.url).toBe("http://h:7778/mcp/sse");
  });
  it("produces the stdio shape when transport is 'stdio'", () => {
    const e = buildMcpEntry({ path: "x", format: "json", transport: "stdio" }, { baseUrl: "http://h:7778", bearer: "tok" }) as Record<string, unknown>;
    expect(e.command).toBe("npx");
    expect(e.env).toMatchObject({ NOVAMEM_BASE_URL: "http://h:7778", NOVAMEM_TOKEN: "tok" });
  });
});

describe("parseCommandFile", () => {
  it("parses YAML frontmatter and body", () => {
    const r = parseCommandFile("---\ndescription: foo\nargument-hint: bar\n---\n\nBody here\n");
    expect(r.frontmatter.description).toBe("foo");
    expect(r.frontmatter["argument-hint"]).toBe("bar");
    expect(r.body).toBe("Body here\n");
  });
  it("treats a file without frontmatter as pure body", () => {
    const r = parseCommandFile("just body\n");
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("just body\n");
  });
});

describe("renderCommand", () => {
  it("re-emits Claude-style markdown with frontmatter for claude-md", () => {
    const out = renderCommand({ frontmatter: { description: "foo" }, body: "B" }, "claude-md");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("description: foo");
    expect(out).toContain("\n\nB");
  });
  it("strips frontmatter for continue-prompt and prepends description", () => {
    const out = renderCommand({ frontmatter: { description: "foo" }, body: "B" }, "continue-prompt");
    expect(out).toBe("foo\n\nB");
  });
  it("emits TOML for gemini-toml", () => {
    const out = renderCommand({ frontmatter: { description: "foo" }, body: "B" }, "gemini-toml");
    expect(out).toContain("description = ");
    expect(out).toContain("prompt = ");
  });
});

describe("destFilename", () => {
  it("uses .md for claude-md", () => {
    expect(destFilename("remember.md", { dir: "x", format: "claude-md" })).toBe("remember.md");
  });
  it("uses .prompt for continue-prompt", () => {
    expect(destFilename("remember.md", { dir: "x", format: "continue-prompt" })).toBe("remember.prompt");
  });
  it("uses .prompt.md for github-prompt-md", () => {
    expect(destFilename("remember.md", { dir: "x", format: "github-prompt-md" })).toBe("remember.prompt.md");
  });
  it("uses .toml for gemini-toml", () => {
    expect(destFilename("remember.md", { dir: "x", format: "gemini-toml" })).toBe("remember.toml");
  });
  it("applies the prefix when configured", () => {
    expect(destFilename("recall.md", { dir: "x", format: "claude-md", prefix: "memory-" })).toBe(
      "memory-recall.md",
    );
  });
});

describe("installCommands", () => {
  it("writes one file per source command for Claude Code", async () => {
    const source = await makeFakeCommandSource();
    const tool = findTool("claude-code")!;
    const r = await installCommands(tool, ctx, { sourceDir: source });
    expect(r.skipped).toBe(false);
    expect(r.filesWritten.length).toBe(2);
    expect(r.filesWritten[0]!.endsWith(".md")).toBe(true);
    const remember = await readFile(join(ctx.projectRoot, ".claude", "commands", "remember.md"), "utf8");
    expect(remember).toContain("description: Save a memory");
    expect(remember).toContain("$ARGUMENTS");
  });
  it("writes .prompt files for Continue", async () => {
    const source = await makeFakeCommandSource();
    const tool = findTool("continue")!;
    const r = await installCommands(tool, ctx, { sourceDir: source });
    expect(r.filesWritten.every((f) => f.endsWith(".prompt"))).toBe(true);
  });
  it("writes .toml files for Gemini", async () => {
    const source = await makeFakeCommandSource();
    const tool = findTool("gemini")!;
    const r = await installCommands(tool, ctx, { sourceDir: source });
    expect(r.filesWritten.every((f) => f.endsWith(".toml"))).toBe(true);
  });
  it("applies prefix for Codex", async () => {
    const source = await makeFakeCommandSource();
    const tool = findTool("codex")!;
    const r = await installCommands(tool, ctx, { sourceDir: source });
    expect(r.filesWritten.every((f) => /memory-(remember|recall)\.md$/.test(f))).toBe(true);
  });
  it("skips tools with no command adapter", async () => {
    const source = await makeFakeCommandSource();
    const tool = findTool("trae")!;
    const r = await installCommands(tool, ctx, { sourceDir: source });
    expect(r.skipped).toBe(true);
    expect(r.filesWritten).toEqual([]);
  });
});
