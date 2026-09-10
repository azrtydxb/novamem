package initcli

// The skill bundle and slash-command sources travel inside the binary.
// The TypeScript installer shipped them in dist/assets, staged there by
// a build script; a single static binary has no dist to ship, so they
// are embedded instead.
//
// assets/ is a COPY of the repo's skills/novamem/ and
// integrations/claude-code/commands/. Copies drift, so assets_test.go
// fails when they diverge from those sources — the same tripwire this
// repo already uses for docs/api/openapi.json and the embedded admin UI.

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed all:assets
var assetsFS embed.FS

// AssetSkillFS and AssetCommandsFS expose the embedded trees rooted at
// the directory each installer expects.
func AssetSkillFS() (fs.FS, error)    { return fs.Sub(assetsFS, "assets/skill") }
func AssetCommandsFS() (fs.FS, error) { return fs.Sub(assetsFS, "assets/commands") }

// MaterializeAssets writes the embedded trees into dir as
// dir/skill and dir/commands, and returns those two paths. The
// installers take source directories rather than an fs.FS, so a binary
// with no checkout beside it stages them once per run.
func MaterializeAssets(dir string) (skillDir, commandsDir string, err error) {
	skillDir = filepath.Join(dir, "skill")
	commandsDir = filepath.Join(dir, "commands")
	if err := writeTree(assetsFS, "assets", dir); err != nil {
		return "", "", err
	}
	return skillDir, commandsDir, nil
}

// writeTree copies an embedded subtree onto disk, rooted at dst.
func writeTree(src fs.FS, root, dst string) error {
	return fs.WalkDir(src, root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := fs.ReadFile(src, path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}
