package initcli

import (
	"os"
	"path/filepath"
	"testing"
)

// The embedded assets are a copy of the repo's sources. A copy that can
// drift silently is a bug waiting to ship, so this fails the build the
// moment they diverge — re-sync with:
//
//	rsync -a --delete skills/novamem/ go/internal/initcli/assets/skill/
//	rsync -a --delete integrations/claude-code/commands/ go/internal/initcli/assets/commands/
func TestEmbeddedAssetsMatchRepoSources(t *testing.T) {
	repo := filepath.Join("..", "..", "..")
	for _, pair := range []struct{ source, embedded string }{
		{filepath.Join(repo, "skills", "novamem"), "assets/skill"},
		{filepath.Join(repo, "integrations", "claude-code", "commands"), "assets/commands"},
	} {
		if _, err := os.Stat(pair.source); err != nil {
			t.Skipf("repo sources unavailable (%v) — drift check needs a checkout", err)
		}
		want := map[string]string{}
		err := filepath.WalkDir(pair.source, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, err := filepath.Rel(pair.source, path)
			if err != nil {
				return err
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			want[filepath.ToSlash(rel)] = string(data)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}

		dir := t.TempDir()
		if err := writeTree(assetsFS, pair.embedded, dir); err != nil {
			t.Fatal(err)
		}
		got := map[string]string{}
		err = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, err := filepath.Rel(dir, path)
			if err != nil {
				return err
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			got[filepath.ToSlash(rel)] = string(data)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}

		for name, content := range want {
			embedded, ok := got[name]
			if !ok {
				t.Errorf("%s: %s is in the repo but not embedded", pair.embedded, name)
				continue
			}
			if embedded != content {
				t.Errorf("%s: %s differs from the repo source", pair.embedded, name)
			}
		}
		for name := range got {
			if _, ok := want[name]; !ok {
				t.Errorf("%s: %s is embedded but no longer in the repo", pair.embedded, name)
			}
		}
	}
}
