import { createHash } from "node:crypto";

import { NOVAMEM_INSTRUCTIONS, TOOL_DEFINITIONS } from "./mcp-tools.js";

export const ADOPTION_REQUIRED_TOOLS = [
  "memory_context",
  "memory_capture",
  "memory_session_recap",
  "memory_search",
  "memory_update",
  "memory_hygiene",
  "memory_evaluate",
  "memory_adoption",
] as const;

export type AdoptionClient = "hermes" | "claude-code" | "claude-desktop" | "codex" | "cursor" | "opencode" | "generic";

export interface AdoptionReportOptions {
  client?: AdoptionClient | string;
  observedTools?: string[];
  observedInstructionsHash?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function refreshGuidance() {
  return {
    hermes: {
      commands: ["/reload-mcp", "/reload-skills", "/reset"],
      requiresNewSession: true,
      note: "Hermes can reload MCP/skills, but the active prompt/tool schema is safest after /reset or a fresh session.",
    },
    claudeCode: {
      commands: ["restart Claude Code session", "re-run tools/list"],
      requiresNewSession: true,
      note: "Claude Code snapshots MCP tools/instructions at session start; start a new session after server or shim updates.",
    },
    claudeDesktop: {
      commands: ["restart Claude Desktop", "open a new chat"],
      requiresNewSession: true,
      note: "Claude Desktop loads stdio MCP servers on app/session start; restart the app after changing config or shim version.",
    },
    codex: {
      commands: ["restart Codex CLI", "re-run tools/list"],
      requiresNewSession: true,
      note: "Codex CLI should refresh by starting a new process/session; prefer the stdio shim if remote transport compatibility is uncertain.",
    },
    generic: {
      commands: ["call initialize", "call tools/list", "compare tool count/names and instructionsHash", "start a new MCP session if stale"],
      requiresNewSession: true,
      note: "Most MCP clients snapshot tools and instructions per session. Treat a mismatch as stale and reconnect.",
    },
  };
}

export function buildAdoptionReport(opts: AdoptionReportOptions = {}) {
  const tools = TOOL_DEFINITIONS.map((t) => t.name).sort();
  const instructionsHash = sha256(NOVAMEM_INSTRUCTIONS);
  const observedTools = [...(opts.observedTools ?? [])].sort();
  const requiredTools = [...ADOPTION_REQUIRED_TOOLS];
  const missingTools = opts.observedTools ? tools.filter((t) => !observedTools.includes(t)) : [];
  const missingRequiredTools = opts.observedTools ? requiredTools.filter((t) => !observedTools.includes(t)) : [];
  const extraTools = opts.observedTools ? observedTools.filter((t) => !tools.includes(t)) : [];
  const instructionMismatch = Boolean(opts.observedInstructionsHash && opts.observedInstructionsHash !== instructionsHash);
  const toolsObserved = Array.isArray(opts.observedTools);
  const instructionsObserved = typeof opts.observedInstructionsHash === "string";

  return {
    server: {
      name: "novamem",
      adoptionSchema: 1,
    },
    mcp: {
      toolCount: tools.length,
      tools,
      instructionsHash,
      instructionsPreview: NOVAMEM_INSTRUCTIONS.slice(0, 240),
      listChanged: false,
    },
    requiredTools,
    features: {
      proactiveContext: tools.includes("memory_context") && (!toolsObserved || observedTools.includes("memory_context")),
      durableCapture: tools.includes("memory_capture") && (!toolsObserved || observedTools.includes("memory_capture")),
      sessionRecap: tools.includes("memory_session_recap"),
      hygiene: tools.includes("memory_hygiene"),
      evaluation: tools.includes("memory_evaluate"),
      sensitivity: true,
      projectAwareContextPacks: true,
      retentionDecay: true,
    },
    refresh: refreshGuidance(),
    requestedClient: opts.client ?? "generic",
    diagnostics: [
      {
        check: "tool_surface",
        ok: toolsObserved ? missingRequiredTools.length === 0 && missingTools.length === 0 && extraTools.length === 0 : false,
        status: toolsObserved ? (missingRequiredTools.length || missingTools.length || extraTools.length ? "stale" : "ok") : "unknown",
        expectedCount: tools.length,
        observedCount: toolsObserved ? observedTools.length : null,
        missingRequiredTools,
        missingTools,
        extraTools,
        action: !toolsObserved
          ? "call tools/list and pass observedTools to verify client adoption"
          : missingRequiredTools.length || missingTools.length || extraTools.length
            ? "refresh MCP session and call tools/list again"
            : "none",
      },
      {
        check: "instructions_hash",
        ok: instructionsObserved ? !instructionMismatch : false,
        status: instructionsObserved ? (instructionMismatch ? "stale" : "ok") : "unknown",
        expected: instructionsHash,
        observed: opts.observedInstructionsHash ?? null,
        action: !instructionsObserved
          ? "capture the instructions hash from MCP initialize and pass observedInstructionsHash"
          : instructionMismatch ? "restart or reset client so MCP initialize instructions are reloaded" : "none",
      },
      {
        check: "mandatory_protocol",
        ok: NOVAMEM_INSTRUCTIONS.includes("Before answering any substantive request") && tools.includes("memory_context") && tools.includes("memory_capture"),
        verifiableAtRuntime: false,
        action: "ensure host LLM receives MCP initialize instructions or install the novamem skill bundle; MCP cannot force host compliance without client-side call telemetry",
      },
    ],
  };
}
