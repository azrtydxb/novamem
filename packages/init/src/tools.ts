/**
 * Registry of every AI-agent host we know how to configure.
 *
 * Inspired by OpenSpec's `AI_TOOLS` table. Each entry declares:
 *   - where its config lives (project-local vs user-global)
 *   - where to drop the skill bundle (every tool gets this)
 *   - optional MCP adapter — the JSON/TOML shape the host expects
 *   - optional slash-command adapter — file format + path convention
 *
 * Adding a new tool is one row. Adding skill-only support is one row
 * with no `mcp` and no `commands`. The installer code reads from this
 * registry only — no per-tool source files.
 */

export type Scope = "project" | "user";

export interface McpAdapter {
  /** Config path relative to the scope root (cwd for project, $HOME for user). */
  path: string;
  format: "json" | "toml";
  /** Top-level key name for the server map. Default: "mcpServers". */
  rootKey?: string;
  /** Map key for our entry. Default: "novamem". */
  serverKey?: string;
  /** Transport our entry advertises. Default: "sse". */
  transport?: "sse" | "stdio";
}

export interface CommandAdapter {
  /** Directory (relative to scope root) where command files live. */
  dir: string;
  /** Output format of the rendered command file. */
  format: "claude-md" | "continue-prompt" | "github-prompt-md" | "gemini-toml";
  /** Optional filename prefix to namespace our commands (e.g. "memory-"). */
  prefix?: string;
}

export interface ToolEntry {
  id: string;
  name: string;
  /** Where this tool lives by default. */
  scope: Scope;
  /**
   * Skill bundle base, relative to the scope root. Final skill path is
   * `${skillsBase}/skills/novamem/`. Set null when the host has no skill
   * convention (rare — every tool here has one).
   */
  skillsBase: string;
  /** Detection paths (relative to scope root). Any match → installed. */
  detect: string[];
  /** MCP wiring — only set for hosts whose MCP format we know. */
  mcp?: McpAdapter;
  /** Slash-command wiring — only set for hosts that consume them. */
  commands?: CommandAdapter;
  /** One-line note printed in the install summary. */
  postInstallHint?: string;
}

/**
 * 30 tools in OpenSpec's inventory + Claude Desktop (which OpenSpec doesn't
 * configure since it's a desktop app rather than a coding agent). Skill
 * support is uniform; MCP and commands are filled in for the hosts whose
 * formats we've verified.
 */
export const TOOLS: readonly ToolEntry[] = [
  // ─── Coding agents with full Claude-Code-style support ───────────────
  {
    id: "claude-code",
    name: "Claude Code",
    scope: "project",
    skillsBase: ".claude",
    detect: [".claude", ".mcp.json"],
    mcp: { path: ".mcp.json", format: "json", transport: "sse" },
    commands: { dir: ".claude/commands", format: "claude-md" },
    postInstallHint: "Restart Claude Code to pick up the new MCP server and skill.",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    scope: "user",
    skillsBase: ".claude",
    detect: [
      "Library/Application Support/Claude/claude_desktop_config.json",
      "AppData/Roaming/Claude/claude_desktop_config.json",
    ],
    mcp: {
      // macOS path — Linux/Windows users get a config-write warning but the
      // installer still works if the dir exists.
      path: "Library/Application Support/Claude/claude_desktop_config.json",
      format: "json",
      // Claude Desktop's MCP loader only accepts stdio entries
      // (`command`/`args`). Writing `{type: "sse", url, headers}` makes
      // it pop up "not valid MCP server configurations and were
      // skipped". Use the stdio shim — it bridges to /mcp/sse on the
      // server with the bearer in env.
      transport: "stdio",
    },
    postInstallHint: "Quit Claude Desktop fully (Cmd-Q on macOS) and reopen — it doesn't hot-reload MCP config.",
  },
  {
    id: "cursor",
    name: "Cursor",
    scope: "project",
    skillsBase: ".cursor",
    detect: [".cursor", ".cursor/mcp.json"],
    mcp: { path: ".cursor/mcp.json", format: "json", transport: "sse" },
    commands: { dir: ".cursor/commands", format: "claude-md" },
    postInstallHint: "Open Cursor → Settings → MCP and toggle 'novamem' on if it isn't already.",
  },
  {
    id: "kilocode",
    name: "Kilo Code",
    scope: "project",
    skillsBase: ".kilocode",
    detect: [".kilocode"],
    mcp: { path: ".kilocode/mcp.json", format: "json", transport: "sse" },
    commands: { dir: ".kilocode/workflows", format: "claude-md" },
  },
  {
    id: "opencode",
    name: "OpenCode",
    scope: "project",
    skillsBase: ".opencode",
    detect: [".opencode"],
    mcp: { path: ".opencode/opencode.json", format: "json", transport: "sse" },
    commands: { dir: ".opencode/commands", format: "claude-md" },
  },
  {
    id: "roocode",
    name: "RooCode",
    scope: "project",
    skillsBase: ".roo",
    detect: [".roo"],
    commands: { dir: ".roo/commands", format: "claude-md" },
  },
  {
    id: "cline",
    name: "Cline",
    scope: "project",
    skillsBase: ".cline",
    detect: [".cline", ".clinerules"],
    commands: { dir: ".clinerules/workflows", format: "claude-md" },
  },
  {
    id: "continue",
    name: "Continue",
    scope: "project",
    skillsBase: ".continue",
    detect: [".continue"],
    commands: { dir: ".continue/prompts", format: "continue-prompt" },
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    scope: "project",
    skillsBase: ".github",
    detect: [
      ".github/copilot-instructions.md",
      ".github/instructions",
      ".github/prompts",
      ".github/skills",
      ".mcp.json",
    ],
    mcp: { path: ".mcp.json", format: "json", transport: "sse" },
    commands: { dir: ".github/prompts", format: "github-prompt-md" },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    scope: "user",
    skillsBase: ".gemini",
    detect: [".gemini"],
    mcp: { path: ".gemini/settings.json", format: "json", transport: "sse" },
    commands: { dir: ".gemini/commands", format: "gemini-toml" },
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    scope: "user",
    skillsBase: ".codex",
    detect: [".codex"],
    mcp: {
      path: ".codex/config.toml",
      format: "toml",
      rootKey: "mcp_servers",
      // Codex CLI's MCP client speaks Streamable-HTTP, not the legacy
      // SSE transport novamem currently exposes at /mcp/sse. Pointing
      // it at the SSE URL produces a cryptic handshake failure:
      //   \"Deserialize error: data did not match any variant of
      //    untagged enum JsonRpcMessage\"
      // Use the stdio shim — it bridges to /mcp/sse internally and is
      // protocol-agnostic to the host.
      transport: "stdio",
    },
    commands: { dir: ".codex/prompts", format: "claude-md", prefix: "memory-" },
  },
  {
    id: "factory",
    name: "Factory Droid",
    scope: "project",
    skillsBase: ".factory",
    detect: [".factory"],
    commands: { dir: ".factory/commands", format: "claude-md" },
  },
  {
    id: "windsurf",
    name: "Windsurf",
    scope: "project",
    skillsBase: ".windsurf",
    detect: [".windsurf"],
    commands: { dir: ".windsurf/workflows", format: "claude-md" },
  },
  {
    id: "amazon-q",
    name: "Amazon Q Developer",
    scope: "project",
    skillsBase: ".amazonq",
    detect: [".amazonq"],
    commands: { dir: ".amazonq/prompts", format: "claude-md", prefix: "memory-" },
  },

  // ─── Skill-only hosts (all 30 from OpenSpec's inventory) ─────────────
  // These hosts read skills from `<skillsBase>/skills/<name>/`. We don't
  // (yet) have verified MCP or slash-command formats for them, so they
  // just get the skill bundle. They can still call the MCP server if the
  // user wires it manually, or via one of the other hosts already doing so.
  { id: "antigravity", name: "Antigravity", scope: "project", skillsBase: ".agent", detect: [".agent"] },
  { id: "auggie", name: "Auggie / Augment CLI", scope: "project", skillsBase: ".augment", detect: [".augment"] },
  { id: "bob", name: "Bob Shell", scope: "project", skillsBase: ".bob", detect: [".bob"] },
  { id: "codebuddy", name: "CodeBuddy Code", scope: "project", skillsBase: ".codebuddy", detect: [".codebuddy"] },
  { id: "costrict", name: "CoStrict", scope: "project", skillsBase: ".cospec", detect: [".cospec"] },
  { id: "crush", name: "Crush", scope: "project", skillsBase: ".crush", detect: [".crush"] },
  { id: "forgecode", name: "ForgeCode", scope: "project", skillsBase: ".forge", detect: [".forge"] },
  { id: "iflow", name: "iFlow", scope: "project", skillsBase: ".iflow", detect: [".iflow"] },
  { id: "junie", name: "Junie", scope: "project", skillsBase: ".junie", detect: [".junie"] },
  { id: "kimi", name: "Kimi CLI", scope: "project", skillsBase: ".kimi", detect: [".kimi"] },
  { id: "kiro", name: "Kiro", scope: "project", skillsBase: ".kiro", detect: [".kiro"] },
  { id: "lingma", name: "Lingma", scope: "project", skillsBase: ".lingma", detect: [".lingma"] },
  { id: "pi", name: "Pi", scope: "project", skillsBase: ".pi", detect: [".pi"] },
  { id: "qoder", name: "Qoder", scope: "project", skillsBase: ".qoder", detect: [".qoder"] },
  { id: "qwen", name: "Qwen Code", scope: "project", skillsBase: ".qwen", detect: [".qwen"] },
  { id: "trae", name: "Trae", scope: "project", skillsBase: ".trae", detect: [".trae"] },
];

export function findTool(id: string): ToolEntry | undefined {
  return TOOLS.find((t) => t.id === id);
}
