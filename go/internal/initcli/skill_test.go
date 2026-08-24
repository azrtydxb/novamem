package initcli

import (
	"os"
	"path/filepath"
	"testing"
)

// makeSkillTree writes a small nested bundle standing in for
// skills/novamem/ and returns its root.
func makeSkillTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, content := range files {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func readTree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = string(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// TestInstallSkillCopiesTreeAndIsIdempotent proves the recursive copy
// reproduces a nested tree and that a second run overwrites rather than
// appending or failing — the property the TS doc comment claims.
func TestInstallSkillCopiesTreeAndIsIdempotent(t *testing.T) {
	source := makeSkillTree(t, map[string]string{
		"SKILL.md":                 "# novamem\n",
		"references/search.md":     "search\n",
		"references/deep/notes.md": "deep\n",
		"scripts/nested/run.sh":    "#!/bin/sh\necho hi\n",
	})
	root := t.TempDir()
	tool := ToolEntry{ID: "claude-code", Scope: ScopeProject, SkillsBase: ".claude"}
	ctx := Context{ProjectRoot: root, Home: root}

	res, err := InstallSkill(tool, ctx, SkillInstallOptions{SourceDir: source})
	if err != nil {
		t.Fatalf("InstallSkill: %v", err)
	}
	want := filepath.Join(root, ".claude", "skills", "novamem")
	if res.Destination != want {
		t.Errorf("destination = %q, want %q", res.Destination, want)
	}
	if !res.Written {
		t.Error("expected Written = true")
	}

	got := readTree(t, res.Destination)
	src := readTree(t, source)
	if len(got) != len(src) {
		t.Fatalf("copied %d files, source has %d: %v", len(got), len(src), got)
	}
	for rel, content := range src {
		if got[rel] != content {
			t.Errorf("%s = %q, want %q", rel, got[rel], content)
		}
	}

	// Second run: same content, no duplication, no error. Also change a
	// file first so we prove it is overwritten, not left stale.
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("# novamem v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallSkill(tool, ctx, SkillInstallOptions{SourceDir: source}); err != nil {
		t.Fatalf("second InstallSkill: %v", err)
	}
	again := readTree(t, res.Destination)
	if len(again) != len(src) {
		t.Errorf("re-run changed the file count: %v", again)
	}
	if again["SKILL.md"] != "# novamem v2\n" {
		t.Errorf("re-run did not overwrite: %q", again["SKILL.md"])
	}
}

func TestInstallSkillDryRunWritesNothing(t *testing.T) {
	source := makeSkillTree(t, map[string]string{"SKILL.md": "x\n"})
	root := t.TempDir()
	tool := ToolEntry{ID: "gemini", Scope: ScopeProject, SkillsBase: ".gemini"}

	res, err := InstallSkill(tool, Context{ProjectRoot: root, Home: root},
		SkillInstallOptions{SourceDir: source, DryRun: true})
	if err != nil {
		t.Fatalf("InstallSkill: %v", err)
	}
	if res.Written {
		t.Error("dry-run must not write")
	}
	if _, err := os.Stat(res.Destination); !os.IsNotExist(err) {
		t.Errorf("dry-run created %s", res.Destination)
	}
}

func TestInstallSkillMissingSource(t *testing.T) {
	tool := ToolEntry{ID: "codex", Scope: ScopeProject, SkillsBase: ".codex"}
	root := t.TempDir()
	_, err := InstallSkill(tool, Context{ProjectRoot: root, Home: root},
		SkillInstallOptions{SourceDir: filepath.Join(root, "nope")})
	if err == nil {
		t.Fatal("expected an error for a missing source directory")
	}
	if _, err := InstallSkill(tool, Context{ProjectRoot: root, Home: root}, SkillInstallOptions{}); err == nil {
		t.Fatal("expected an error when SourceDir is unset")
	}
}
