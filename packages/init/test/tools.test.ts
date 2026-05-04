import { describe, it, expect } from "vitest";
import { TOOLS, findTool } from "../src/tools.js";

describe("tool registry", () => {
  it("has at least the OpenSpec inventory + Claude Desktop", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(30);
  });
  it("ids are unique", () => {
    const ids = TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("every tool has a non-empty skillsBase and at least one detect path", () => {
    for (const t of TOOLS) {
      expect(t.skillsBase).toBeTruthy();
      expect(t.detect.length).toBeGreaterThan(0);
    }
  });
  it("scope is project or user", () => {
    for (const t of TOOLS) {
      expect(["project", "user"]).toContain(t.scope);
    }
  });
  it("findTool returns undefined for unknown ids", () => {
    expect(findTool("does-not-exist")).toBeUndefined();
  });
  it("findTool finds known tools", () => {
    expect(findTool("claude-code")?.name).toBe("Claude Code");
    expect(findTool("cursor")?.name).toBe("Cursor");
    expect(findTool("codex")?.scope).toBe("user");
  });
  it("MCP-capable tools all use known formats and transports", () => {
    for (const t of TOOLS) {
      if (!t.mcp) continue;
      expect(["json", "toml"]).toContain(t.mcp.format);
      expect(["sse", "stdio", undefined]).toContain(t.mcp.transport);
    }
  });
  it("command-capable tools all use known formats", () => {
    for (const t of TOOLS) {
      if (!t.commands) continue;
      expect([
        "claude-md",
        "continue-prompt",
        "github-prompt-md",
        "gemini-toml",
      ]).toContain(t.commands.format);
    }
  });
});
