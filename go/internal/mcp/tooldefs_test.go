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
