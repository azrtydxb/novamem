package initcli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsInstalledFindsProbePath(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".present"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := Context{ProjectRoot: root, Home: home}

	present := ToolEntry{ID: "present", Scope: ScopeProject, Detect: []string{"nope", ".present"}}
	if !IsInstalled(present, ctx) {
		t.Errorf("expected the tool with an existing probe path to be detected")
	}

	absent := ToolEntry{ID: "absent", Scope: ScopeProject, Detect: []string{"nope", "also-nope"}}
	if IsInstalled(absent, ctx) {
		t.Errorf("expected a tool with no existing probe path to be undetected")
	}

	// A user-scope tool resolves its probes against Home, not the project
	// root — the same relative path must not leak across scopes.
	userScoped := ToolEntry{ID: "user", Scope: ScopeUser, Detect: []string{".present"}}
	if IsInstalled(userScoped, ctx) {
		t.Errorf("user-scope probe resolved against the project root")
	}
	if err := os.WriteFile(filepath.Join(home, ".present"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !IsInstalled(userScoped, ctx) {
		t.Errorf("user-scope probe not found under Home")
	}
}

func TestIsInstalledNoProbesIsNotInstalled(t *testing.T) {
	ctx := Context{ProjectRoot: t.TempDir(), Home: t.TempDir()}
	if IsInstalled(ToolEntry{ID: "empty", Scope: ScopeProject}, ctx) {
		t.Errorf("a tool with no detect paths must never look installed")
	}
}

func TestDetectAllEmptyRootsFindsNothing(t *testing.T) {
	ctx := Context{ProjectRoot: t.TempDir(), Home: t.TempDir()}
	if got := DetectAll(ctx); len(got) != 0 {
		t.Errorf("DetectAll on empty roots = %d tools, want 0", len(got))
	}
}

func TestDetectAllFindsRegisteredTool(t *testing.T) {
	if len(Tools) == 0 {
		t.Skip("empty registry")
	}
	root := t.TempDir()
	home := t.TempDir()
	ctx := Context{ProjectRoot: root, Home: home}

	// Materialise the first probe of the first tool that has one, then
	// assert DetectAll surfaces exactly that tool.
	var target ToolEntry
	for _, tool := range Tools {
		if len(tool.Detect) > 0 {
			target = tool
			break
		}
	}
	if target.ID == "" {
		t.Skip("no tool in the registry declares a detect path")
	}
	probe := filepath.Join(RootFor(target, ctx), target.Detect[0])
	if err := os.MkdirAll(filepath.Dir(probe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(probe, 0o755); err != nil {
		t.Fatal(err)
	}

	found := DetectAll(ctx)
	if len(found) == 0 {
		t.Fatalf("DetectAll did not detect %s after creating %s", target.ID, probe)
	}
	for _, tool := range found {
		if tool.ID == target.ID {
			return
		}
	}
	t.Fatalf("DetectAll = %v, want it to contain %s", found, target.ID)
}
