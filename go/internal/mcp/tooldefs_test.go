package mcp

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
)

// Keeps the embedded tooldefs.json honest against the conformance
// snapshot (packages/conformance/reference/tools.snapshot.json), which
// pins tool names AND inputSchema JSON. Same in-repo technique as
// warmstore's migrations_journal_test.go; skips when the monorepo isn't
// checked out around the module.
func TestToolDefsMatchConformanceSnapshot(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/conformance/reference/tools.snapshot.json")
	if err != nil {
		t.Skipf("snapshot not reachable from module: %v", err)
	}
	var snapshot struct {
		Names   []string                   `json:"names"`
		Schemas map[string]json.RawMessage `json:"schemas"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}

	var defs []struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	}
	if err := json.Unmarshal(ToolDefinitions(), &defs); err != nil {
		t.Fatal(err)
	}
	if len(defs) != 21 {
		t.Fatalf("expected 21 tools, got %d", len(defs))
	}

	names := make([]string, 0, len(defs))
	for _, d := range defs {
		names = append(names, d.Name)
		if d.Description == "" {
			t.Errorf("tool %s has no description", d.Name)
		}
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, snapshot.Names) {
		t.Fatalf("tool names diverge from snapshot:\n got  %v\n want %v", names, snapshot.Names)
	}

	for _, d := range defs {
		want, ok := snapshot.Schemas[d.Name]
		if !ok {
			t.Errorf("snapshot has no schema for %s", d.Name)
			continue
		}
		var gotV, wantV any
		if err := json.Unmarshal(d.InputSchema, &gotV); err != nil {
			t.Fatalf("%s inputSchema: %v", d.Name, err)
		}
		if err := json.Unmarshal(want, &wantV); err != nil {
			t.Fatalf("%s snapshot schema: %v", d.Name, err)
		}
		if !reflect.DeepEqual(gotV, wantV) {
			got, _ := json.Marshal(gotV)
			wantB, _ := json.Marshal(wantV)
			t.Errorf("inputSchema for %s diverges from snapshot:\n got  %s\n want %s", d.Name, got, wantB)
		}
	}
}

// Every tool carries MCP `annotations` — readOnlyHint, idempotentHint,
// openWorldHint and a human title — and they are part of what a host
// shows and how it decides whether a call is safe to repeat.
//
// They are also the thing a generator loses first. The contract now
// flows from api/openapi.yaml through cmd/gen-contract, and the first
// version of that generator decoded each tool into a struct of
// name/description/inputSchema — which silently dropped annotations from
// all 21 tools and regenerated a file that looked fine. Nothing in the
// suite noticed, because nothing pinned them.
//
// This pins them. A future regression to field-by-field decoding fails
// here rather than shipping a quietly thinner surface.
func TestEveryToolKeepsItsAnnotations(t *testing.T) {
	var defs []struct {
		Name        string `json:"name"`
		Annotations *struct {
			Title         string `json:"title"`
			ReadOnlyHint  *bool  `json:"readOnlyHint"`
			OpenWorldHint *bool  `json:"openWorldHint"`
		} `json:"annotations"`
	}
	if err := json.Unmarshal(toolDefsRaw, &defs); err != nil {
		t.Fatalf("tooldefs.json: %v", err)
	}
	if len(defs) == 0 {
		t.Fatal("no tools")
	}
	for _, d := range defs {
		if d.Annotations == nil {
			t.Errorf("%s has no annotations — a generator that drops them ships a thinner surface silently", d.Name)
			continue
		}
		if d.Annotations.Title == "" {
			t.Errorf("%s has no annotations.title", d.Name)
		}
		if d.Annotations.ReadOnlyHint == nil {
			t.Errorf("%s has no annotations.readOnlyHint — hosts use it to decide whether a call is safe to repeat", d.Name)
		}
		if d.Annotations.OpenWorldHint == nil {
			t.Errorf("%s has no annotations.openWorldHint", d.Name)
		}
	}
}
