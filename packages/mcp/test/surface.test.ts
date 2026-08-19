import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
const instructions =
  source.match(/const NOVAMEM_INSTRUCTIONS = `([\s\S]*?)`;\n\n\/\*\*/)?.[1] ??
  "";
const toolDefSource =
  source.match(/const TOOL_DEFINITIONS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
const toolNames = [...toolDefSource.matchAll(/name: "([^"]+)"/g)].map(
  (m) => m[1]
);

describe("stdio MCP surface", () => {
  it("mentions every advertised tool in initialize instructions", () => {
    expect(toolNames.length).toBe(21);
    for (const name of toolNames) expect(instructions).toContain(name);
  });

  it("preserves MCP tool annotations from the canonical server surface", () => {
    expect(source).toContain("function annotationsFor");
    expect(source).toContain("destructiveHint: true");
    expect(source).toContain("readOnlyHint: true");
  });
});
