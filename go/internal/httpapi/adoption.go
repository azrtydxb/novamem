// Adoption/refresh diagnostics report. Transcribed from
// packages/server/src/adoption.ts (buildAdoptionReport) with the tool
// surface from mcp-tools.ts (21 tools: 14 memory_* + 7 project_*) and
// the MCP instructions block from mcp-instructions.ts, verbatim, so the
// instructionsHash matches the TS server byte-for-byte.
package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// toolNames — mcp-tools.ts TOOL_DEFINITIONS names (declaration order;
// the report sorts them).
var toolNames = []string{
	"memory_context",
	"memory_capture",
	"memory_session_recap",
	"memory_hygiene",
	"memory_evaluate",
	"memory_adoption",
	"memory_search",
	"memory_remember",
	"memory_today",
	"memory_recent",
	"memory_neighbors",
	"memory_forget",
	"memory_update",
	"memory_stats",
	"project_list",
	"project_create",
	"project_delete",
	"project_activate",
	"project_deactivate",
	"project_share",
	"project_unshare",
}

// adoptionRequiredTools — adoption.ts ADOPTION_REQUIRED_TOOLS.
var adoptionRequiredTools = []string{
	"memory_context",
	"memory_capture",
	"memory_session_recap",
	"memory_search",
	"memory_update",
	"memory_hygiene",
	"memory_evaluate",
	"memory_adoption",
}

// novamemInstructions — mcp-instructions.ts NOVAMEM_INSTRUCTIONS,
// verbatim (backticks and all) so sha256 hashes agree across servers.
const novamemInstructions = "# NovaMem long-term memory\n" +
	"\n" +
	"You have persistent memory through the `novamem` MCP server: hybrid search (keyword + vector + graph), project-scoped sub-brains, hygiene/evaluation diagnostics, and durable capture. **Use it proactively.** Do not wait for the user to say \"use memory\".\n" +
	"\n" +
	"## Mandatory memory protocol\n" +
	"\n" +
	"Before answering any substantive request, call `memory_context` once with the current user message. Substantive means technical work, planning, troubleshooting, recommendations, personal preferences, project work, or anything where prior context may change the answer. Skip only greetings/filler or when the user explicitly says not to use memory.\n" +
	"\n" +
	"Before asking the user to repeat context, call `memory_context` or targeted `memory_search` first.\n" +
	"\n" +
	"After meaningful work, call `memory_capture` for durable outcomes: decisions, changed preferences, current setup, bug root causes, recurring constraints, architecture invariants, or verified environment facts. Do not save secrets. Use `sensitivity` (`public`, `internal`, `private`, `sensitive`) for privacy-sensitive facts; recall defaults to `maxSensitivity: \"private\"` and excludes `sensitive` unless explicitly requested. The capture path handles near-duplicate update and contradiction supersession; prefer it over raw `memory_remember` for normal agent writes.\n" +
	"\n" +
	"For end-of-session/task summaries, prefer `memory_session_recap` with typed arrays (decisions, setupFacts, rootCauses, preferences, projectConventions, safetyConstraints, other) instead of dumping transcripts.\n" +
	"\n" +
	"## Tool surface\n" +
	"\n" +
	"Read/recall: `memory_context`, `memory_search`, `memory_recent`, `memory_today`, `memory_neighbors`, `memory_stats`, `memory_adoption`.\n" +
	"\n" +
	"Write/mutate: `memory_capture`, `memory_session_recap`, `memory_remember`, `memory_update`, `memory_forget`.\n" +
	"\n" +
	"Diagnostics: `memory_hygiene`, `memory_evaluate`, `memory_adoption`.\n" +
	"\n" +
	"Projects: `project_list`, `project_create`, `project_delete`, `project_activate`, `project_deactivate`, `project_share`, `project_unshare`.\n" +
	"\n" +
	"## When to search\n" +
	"\n" +
	"Search before: prior-work references, non-trivial design choices, unstated preferences/conventions, unfamiliar project areas, or any question where durable context may change the answer. Judge hits by whether the content actually answers the question, not by an absolute score: the usable score range depends on the deployed embedding model, and on some models (bge-m3) relevant and irrelevant hits overlap so heavily that no fixed cutoff separates them.\n" +
	"\n" +
	"Default search weights are tuned for prose. Useful overrides: `{ keyword: 1, vector: 0 }` for exact ids/symbols/hashes; `{ vector: 1, keyword: 0 }` for semantic recall; `{ graph: 1 }` for neighbour-driven recall.\n" +
	"\n" +
	"## When to save\n" +
	"\n" +
	"Save durable facts that will matter next session: decisions with reasoning, recurring user preferences, hidden constraints, root causes plus fixes, architecture invariants, and verified setup facts. Do not save transient task chatter, secrets, or raw stack traces.\n" +
	"\n" +
	"The worthiness gate rejects too-short or filler entries. Pass `force: true` only when the user explicitly asked to save it. Exact duplicates are deduplicated; treat `{ id, deduplicated: true }` as success.\n" +
	"\n" +
	"When manually correcting a known entry id, use `memory_update`; otherwise let `memory_capture` handle duplicate/update and supersession.\n" +
	"\n" +
	"## Projects\n" +
	"\n" +
	"A project is a shared sub-brain. Use `project_activate({ project })` when the user signals work in a specific project. Reads then union user-global with the active project; writes target the active project. Pass `project` explicitly when needed.\n"

type adoptionOptions struct {
	Client                   string
	ObservedTools            []string
	ObservedToolsSet         bool
	ObservedInstructionsHash *string
}

func sha256HexStr(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// refreshGuidance — adoption.ts refreshGuidance(), verbatim.
func refreshGuidance() map[string]any {
	return map[string]any{
		"hermes": map[string]any{
			"commands":           []string{"/reload-mcp", "/reload-skills", "/reset"},
			"requiresNewSession": true,
			"note":               "Hermes can reload MCP/skills, but the active prompt/tool schema is safest after /reset or a fresh session.",
		},
		"claudeCode": map[string]any{
			"commands":           []string{"restart Claude Code session", "re-run tools/list"},
			"requiresNewSession": true,
			"note":               "Claude Code snapshots MCP tools/instructions at session start; start a new session after server or shim updates.",
		},
		"claudeDesktop": map[string]any{
			"commands":           []string{"restart Claude Desktop", "open a new chat"},
			"requiresNewSession": true,
			"note":               "Claude Desktop loads stdio MCP servers on app/session start; restart the app after changing config or shim version.",
		},
		"codex": map[string]any{
			"commands":           []string{"restart Codex CLI", "re-run tools/list"},
			"requiresNewSession": true,
			"note":               "Codex CLI should refresh by starting a new process/session; prefer the stdio shim if remote transport compatibility is uncertain.",
		},
		"generic": map[string]any{
			"commands":           []string{"call initialize", "call tools/list", "compare tool count/names and instructionsHash", "start a new MCP session if stale"},
			"requiresNewSession": true,
			"note":               "Most MCP clients snapshot tools and instructions per session. Treat a mismatch as stale and reconnect.",
		},
	}
}

func buildAdoptionReport(opts adoptionOptions) map[string]any {
	tools := append([]string{}, toolNames...)
	sort.Strings(tools)
	toolSet := map[string]bool{}
	for _, t := range tools {
		toolSet[t] = true
	}
	instructionsHash := sha256HexStr(novamemInstructions)
	observedTools := append([]string{}, opts.ObservedTools...)
	sort.Strings(observedTools)
	observedSet := map[string]bool{}
	for _, t := range observedTools {
		observedSet[t] = true
	}
	requiredTools := append([]string{}, adoptionRequiredTools...)

	missingTools := []string{}
	missingRequiredTools := []string{}
	extraTools := []string{}
	if opts.ObservedToolsSet {
		for _, t := range tools {
			if !observedSet[t] {
				missingTools = append(missingTools, t)
			}
		}
		for _, t := range requiredTools {
			if !observedSet[t] {
				missingRequiredTools = append(missingRequiredTools, t)
			}
		}
		for _, t := range observedTools {
			if !toolSet[t] {
				extraTools = append(extraTools, t)
			}
		}
	}
	instructionMismatch := opts.ObservedInstructionsHash != nil && *opts.ObservedInstructionsHash != instructionsHash
	toolsObserved := opts.ObservedToolsSet
	instructionsObserved := opts.ObservedInstructionsHash != nil

	toolSurfaceStale := len(missingRequiredTools) > 0 || len(missingTools) > 0 || len(extraTools) > 0
	toolSurfaceStatus := "unknown"
	toolSurfaceAction := "call tools/list and pass observedTools to verify client adoption"
	if toolsObserved {
		if toolSurfaceStale {
			toolSurfaceStatus = "stale"
			toolSurfaceAction = "refresh MCP session and call tools/list again"
		} else {
			toolSurfaceStatus = "ok"
			toolSurfaceAction = "none"
		}
	}
	var observedCount any
	if toolsObserved {
		observedCount = len(observedTools)
	}
	instructionsStatus := "unknown"
	instructionsAction := "capture the instructions hash from MCP initialize and pass observedInstructionsHash"
	if instructionsObserved {
		if instructionMismatch {
			instructionsStatus = "stale"
			instructionsAction = "restart or reset client so MCP initialize instructions are reloaded"
		} else {
			instructionsStatus = "ok"
			instructionsAction = "none"
		}
	}
	var observedHash any
	if opts.ObservedInstructionsHash != nil {
		observedHash = *opts.ObservedInstructionsHash
	}
	client := opts.Client
	if client == "" {
		client = "generic"
	}

	return map[string]any{
		"server": map[string]any{"name": "novamem", "adoptionSchema": 1},
		"mcp": map[string]any{
			"toolCount":           len(tools),
			"tools":               tools,
			"instructionsHash":    instructionsHash,
			"instructionsPreview": utf16Prefix(novamemInstructions, 240),
			"listChanged":         false,
		},
		"requiredTools": requiredTools,
		"features": map[string]any{
			"proactiveContext":         toolSet["memory_context"] && (!toolsObserved || observedSet["memory_context"]),
			"durableCapture":           toolSet["memory_capture"] && (!toolsObserved || observedSet["memory_capture"]),
			"sessionRecap":             toolSet["memory_session_recap"],
			"hygiene":                  toolSet["memory_hygiene"],
			"evaluation":               toolSet["memory_evaluate"],
			"sensitivity":              true,
			"projectAwareContextPacks": true,
			"retentionDecay":           true,
		},
		"refresh":         refreshGuidance(),
		"requestedClient": client,
		"diagnostics": []map[string]any{
			{
				"check":                "tool_surface",
				"ok":                   toolsObserved && !toolSurfaceStale,
				"status":               toolSurfaceStatus,
				"expectedCount":        len(tools),
				"observedCount":        observedCount,
				"missingRequiredTools": missingRequiredTools,
				"missingTools":         missingTools,
				"extraTools":           extraTools,
				"action":               toolSurfaceAction,
			},
			{
				"check":    "instructions_hash",
				"ok":       instructionsObserved && !instructionMismatch,
				"status":   instructionsStatus,
				"expected": instructionsHash,
				"observed": observedHash,
				"action":   instructionsAction,
			},
			{
				"check": "mandatory_protocol",
				// NOVAMEM_INSTRUCTIONS.includes("Before answering any
				// substantive request") && memory_context && memory_capture
				// — statically true for this build, evaluated anyway so a
				// future instructions edit can flip it exactly like TS.
				"ok":                  strings.Contains(novamemInstructions, "Before answering any substantive request") && toolSet["memory_context"] && toolSet["memory_capture"],
				"verifiableAtRuntime": false,
				"action":              "ensure host LLM receives MCP initialize instructions or install the novamem skill bundle; MCP cannot force host compliance without client-side call telemetry",
			},
		},
	}
}

// utf16Prefix — JS String.slice(0, n) semantics for the preview.
func utf16Prefix(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}
