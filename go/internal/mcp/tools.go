// Package mcp is the hand-rolled MCP layer: the frozen tool
// advertisement, a minimal JSON-RPC server for the five methods the
// novamem surface actually uses (initialize, notifications/initialized,
// tools/list, tools/call, ping), the per-user session registries with
// cap + idle reaping, and both HTTP transports (Streamable HTTP and the
// legacy SSE pair). The official go-sdk was evaluated and skipped: its
// transports own session management internally, and matching the TS
// server's wire contract (exact 404/403/429 error bodies, per-user caps,
// query-string SSE sessions) would mean fighting the SDK instead of
// writing ~400 lines of plain net/http.
//
// Tool dispatch itself lives in httpapi (it reuses the request
// validators, adoption report, and scope resolution already transcribed
// there) and is injected via CallFunc.
package mcp

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
)

// tooldefs.json is generated from the TS source of truth
// (packages/server/src/mcp-tools.ts TOOL_DEFINITIONS) via:
//
//	cd packages/server && node_modules/.bin/tsx -e 'import("./src/mcp-tools.js").then(m => process.stdout.write(JSON.stringify(m.TOOL_DEFINITIONS, null, 2) + "\n"))' > ../../go/internal/mcp/tooldefs.json
//
// The conformance snapshot (packages/conformance/reference/
// tools.snapshot.json) pins names + inputSchema; tooldefs_test.go keeps
// this copy honest against it.
//
//go:embed tooldefs.json
var toolDefsJSON []byte

// toolDefsRaw is the parsed-once array, re-marshalled verbatim into
// every tools/list response.
var toolDefsRaw json.RawMessage

// toolNames indexes the advertised tool names for tests and callers.
var toolNames []string

func init() {
	var defs []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(toolDefsJSON, &defs); err != nil {
		panic(fmt.Sprintf("mcp: tooldefs.json is invalid: %v", err))
	}
	for _, d := range defs {
		toolNames = append(toolNames, d.Name)
	}
	// Compact so the wire payload carries no indentation.
	var buf bytes.Buffer
	if err := json.Compact(&buf, toolDefsJSON); err != nil {
		panic(err)
	}
	toolDefsRaw = buf.Bytes()
}

// ToolNames returns the advertised tool names in declaration order.
func ToolNames() []string { return append([]string{}, toolNames...) }

// ToolDefinitions returns the raw tools/list array.
func ToolDefinitions() json.RawMessage { return toolDefsRaw }

// ErrUnknownTool signals a tools/call for a name outside the surface;
// the JSON-RPC layer renders it as the TS dispatcher's
// "unknown tool: <name>" isError content.
var ErrUnknownTool = errors.New("unknown tool")
