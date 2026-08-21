package initcli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExistsAndReadFileMaybe(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")

	if Exists(path) {
		t.Errorf("Exists on a missing path = true")
	}
	content, ok, err := ReadFileMaybe(path)
	if err != nil {
		t.Fatalf("ReadFileMaybe on a missing file returned an error: %v", err)
	}
	if ok || content != "" {
		t.Errorf("ReadFileMaybe(missing) = (%q, %v), want (\"\", false)", content, ok)
	}

	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !Exists(path) {
		t.Errorf("Exists on an existing file = false")
	}
	content, ok, err = ReadFileMaybe(path)
	if err != nil || !ok || content != "hello" {
		t.Errorf("ReadFileMaybe = (%q, %v, %v), want (\"hello\", true, nil)", content, ok, err)
	}
}

func TestWriteFileEnsureDirCreatesParents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deep", "deeper", "out.json")
	if err := WriteFileEnsureDir(path, "{}\n"); err != nil {
		t.Fatalf("WriteFileEnsureDir: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "{}\n" {
		t.Errorf("content = %q, want %q", b, "{}\n")
	}
	// Overwrites, not appends.
	if err := WriteFileEnsureDir(path, "x"); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(path)
	if string(b) != "x" {
		t.Errorf("rewrite content = %q, want %q", b, "x")
	}
}

func TestCopyDirReproducesNestedTreeWithExecutableBit(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	dst := filepath.Join(t.TempDir(), "dst")
	if err := os.MkdirAll(filepath.Join(src, "skills", "novamem"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("# skill"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "skills", "novamem", "hook.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := CopyDir(src, dst); err != nil {
		t.Fatalf("CopyDir: %v", err)
	}

	b, err := os.ReadFile(filepath.Join(dst, "SKILL.md"))
	if err != nil || string(b) != "# skill" {
		t.Errorf("copied SKILL.md = %q, %v", b, err)
	}
	hook := filepath.Join(dst, "skills", "novamem", "hook.sh")
	info, err := os.Stat(hook)
	if err != nil {
		t.Fatalf("nested file not copied: %v", err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("executable bit lost: mode = %v", info.Mode().Perm())
	}

	// Idempotent: a second copy over changed content overwrites it and
	// keeps the mode.
	if err := os.WriteFile(hook, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := CopyDir(src, dst); err != nil {
		t.Fatalf("second CopyDir: %v", err)
	}
	b, _ = os.ReadFile(hook)
	if string(b) != "#!/bin/sh\n" {
		t.Errorf("re-copy content = %q", b)
	}
	info, _ = os.Stat(hook)
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("re-copy lost the executable bit: mode = %v", info.Mode().Perm())
	}
}

func TestCopyDirMissingSource(t *testing.T) {
	dst := filepath.Join(t.TempDir(), "dst")
	if err := CopyDir(filepath.Join(t.TempDir(), "nope"), dst); err == nil {
		t.Errorf("CopyDir from a missing source = nil, want an error")
	}
}
