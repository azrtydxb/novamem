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

	"github.com/azrtydxb/novamem/go/internal/agentskill"
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

// novamemInstructions is the MCP `instructions` payload, rendered from
// the marked regions of the one skill document (agentskill). It used to
// be a hand-maintained copy of that text, which is a contract that
// agreed only while someone kept both sides aligned.
//
// A malformed or marker-less skill is a programming error caught by
// agentskill's own tests, so failing here would mean shipping a server
// that tells agents nothing; fall back to a pointer at the real thing.
var novamemInstructions = func() string {
	s, err := agentskill.Instructions()
	if err != nil {
		return "novamem long-term memory: see https://github.com/azrtydxb/novamem"
	}
	return s
}()

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
func refreshGuidance() obj {
	client := func(commands []string, note string) obj {
		return obj{{"commands", commands}, {"requiresNewSession", true}, {"note", note}}
	}
	return obj{
		{"hermes", client([]string{"/reload-mcp", "/reload-skills", "/reset"},
			"Hermes can reload MCP/skills, but the active prompt/tool schema is safest after /reset or a fresh session.")},
		{"claudeCode", client([]string{"restart Claude Code session", "re-run tools/list"},
			"Claude Code snapshots MCP tools/instructions at session start; start a new session after server or shim updates.")},
		{"claudeDesktop", client([]string{"restart Claude Desktop", "open a new chat"},
			"Claude Desktop loads stdio MCP servers on app/session start; restart the app after changing config or shim version.")},
		{"codex", client([]string{"restart Codex CLI", "re-run tools/list"},
			"Codex CLI should refresh by starting a new process/session; prefer the stdio shim if remote transport compatibility is uncertain.")},
		{"generic", client([]string{"call initialize", "call tools/list", "compare tool count/names and instructionsHash", "start a new MCP session if stale"},
			"Most MCP clients snapshot tools and instructions per session. Treat a mismatch as stale and reconnect.")},
	}
}

func buildAdoptionReport(opts adoptionOptions) obj {
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

	return obj{
		{"server", obj{{"name", "novamem"}, {"adoptionSchema", 1}}},
		{"mcp", obj{
			{"toolCount", len(tools)},
			{"tools", tools},
			{"instructionsHash", instructionsHash},
			{"instructionsPreview", utf16Prefix(novamemInstructions, 240)},
			{"listChanged", false},
		}},
		{"requiredTools", requiredTools},
		{"features", obj{
			{"proactiveContext", toolSet["memory_context"] && (!toolsObserved || observedSet["memory_context"])},
			{"durableCapture", toolSet["memory_capture"] && (!toolsObserved || observedSet["memory_capture"])},
			{"sessionRecap", toolSet["memory_session_recap"]},
			{"hygiene", toolSet["memory_hygiene"]},
			{"evaluation", toolSet["memory_evaluate"]},
			{"sensitivity", true},
			{"projectAwareContextPacks", true},
			{"retentionDecay", true},
		}},
		{"refresh", refreshGuidance()},
		{"requestedClient", client},
		{"diagnostics", []obj{
			{
				{"check", "tool_surface"},
				{"ok", toolsObserved && !toolSurfaceStale},
				{"status", toolSurfaceStatus},
				{"expectedCount", len(tools)},
				{"observedCount", observedCount},
				{"missingRequiredTools", missingRequiredTools},
				{"missingTools", missingTools},
				{"extraTools", extraTools},
				{"action", toolSurfaceAction},
			},
			{
				{"check", "instructions_hash"},
				{"ok", instructionsObserved && !instructionMismatch},
				{"status", instructionsStatus},
				{"expected", instructionsHash},
				{"observed", observedHash},
				{"action", instructionsAction},
			},
			{
				{"check", "mandatory_protocol"},
				// The instructions must actually carry the mandatory
				// protocol, and the two tools it turns on must be
				// advertised. Anchored on the section heading rather than
				// a sentence from its body: the prose is now rendered
				// from SKILL.md, so pinning a phrase would report a
				// protocol failure every time someone reworded a line.
				// Removing the section still flips this to false, which
				// is the case worth catching.
				{"ok", strings.Contains(novamemInstructions, "## Mandatory memory protocol") && toolSet["memory_context"] && toolSet["memory_capture"]},
				{"verifiableAtRuntime", false},
				{"action", "ensure host LLM receives MCP initialize instructions or install the novamem skill bundle; MCP cannot force host compliance without client-side call telemetry"},
			},
		}},
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
