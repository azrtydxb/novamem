package httpapi

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/mcp"
)

// Dispatch paths that answer before touching the engine or warm store —
// validation errors (parseToolArgs parity), strict-schema rejection,
// unknown tools, and the DB-free memory_adoption tool. tools/call
// correctness against real data is the live conformance suite's job.
func TestCallToolValidation(t *testing.T) {
	s := &server{} // nil engine/warm: these paths must not reach them
	ctx := context.Background()

	_, err := s.callTool(ctx, "public", "memory_search", map[string]any{})
	if err == nil || err.Error() != "invalid argument 'query': Required" {
		t.Fatalf("memory_search{}: %v", err)
	}

	_, err = s.callTool(ctx, "public", "memory_remember", map[string]any{})
	if err == nil || err.Error() != "invalid argument 'content': Required" {
		t.Fatalf("memory_remember{}: %v", err)
	}

	_, err = s.callTool(ctx, "public", "memory_neighbors", map[string]any{"depth": float64(2)})
	if err == nil || err.Error() != "invalid argument 'id': Required" {
		t.Fatalf("memory_neighbors: %v", err)
	}

	// Strict empty schemas reject unknown keys like zod .strict().
	_, err = s.callTool(ctx, "public", "memory_stats", map[string]any{"bogus": true})
	if err == nil || !strings.Contains(err.Error(), "Unrecognized key(s) in object: 'bogus'") {
		t.Fatalf("memory_stats strict: %v", err)
	}

	// Wrong-typed argument surfaces the zod-style message.
	_, err = s.callTool(ctx, "public", "memory_search", map[string]any{"query": float64(7)})
	if err == nil || !strings.Contains(err.Error(), "invalid argument 'query': Expected string") {
		t.Fatalf("memory_search typed: %v", err)
	}

	// Unknown tool → the sentinel the transport renders as
	// "unknown tool: <name>" isError content.
	_, err = s.callTool(ctx, "public", "memory_nonexistent", map[string]any{})
	if !errors.Is(err, mcp.ErrUnknownTool) {
		t.Fatalf("unknown tool: %v", err)
	}
}

func TestCallToolAdoptionReport(t *testing.T) {
	s := &server{}
	r, err := s.callTool(context.Background(), "public", "memory_adoption",
		map[string]any{"client": "claude-code", "observedTools": []any{"memory_search"}})
	if err != nil {
		t.Fatal(err)
	}
	report, ok := r.(map[string]any)
	if !ok {
		t.Fatalf("report type %T", r)
	}
	mcpInfo := report["mcp"].(map[string]any)
	if mcpInfo["toolCount"] != 21 {
		t.Fatalf("toolCount = %v", mcpInfo["toolCount"])
	}
	if report["requestedClient"] != "claude-code" {
		t.Fatalf("requestedClient = %v", report["requestedClient"])
	}
}

// The advertised tool surface and the dispatch switch must not drift:
// every advertised name dispatches to something (i.e. does not return
// ErrUnknownTool with empty-but-valid args — validation errors and nil
// panics from missing stores are fine here, unknown-tool is not).
func TestDispatchCoversAdvertisedSurface(t *testing.T) {
	s := &server{}
	for _, name := range mcp.ToolNames() {
		func() {
			defer func() { recover() }() // nil engine/warm may panic — that still proves dispatch coverage
			_, err := s.callTool(context.Background(), "public", name, map[string]any{})
			if errors.Is(err, mcp.ErrUnknownTool) {
				t.Errorf("advertised tool %s is not dispatched", name)
			}
		}()
	}
}
