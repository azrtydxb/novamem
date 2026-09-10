package initcli

// Skill installer — uniform across every tool in the registry.
//
// The skill bundle is recursively copied into the host's
// <SkillsBase>/skills/novamem/. Idempotent: re-running overwrites with
// the latest content.
//
// Deliberate difference from the TypeScript original: there is no
// bundledSkillPath(). In TS the bundle was a build artifact — `pnpm
// build` copied the monorepo's skills/novamem/ into dist/assets/skill/
// and bundledSkillPath() derived that location from import.meta.url, so
// a forgotten build produced a runtime "run `pnpm build` first" error.
// In Go the source of truth is the repo's skills/novamem/ directory
// directly and nothing is staged into a dist tree, so the caller passes
// the path (SkillInstallOptions.SourceDir) rather than having it derived
// from the executable's location — deriving it from os.Executable() would
// be wrong for both `go run` and an installed binary.

import (
	"fmt"
	"os"
	"path/filepath"
)

// SkillInstallResult reports where the bundle landed and whether
// anything was actually written (false in dry-run mode).
type SkillInstallResult struct {
	ToolID      string
	Destination string
	Written     bool
}

// SkillInstallOptions tunes InstallSkill.
type SkillInstallOptions struct {
	DryRun bool
	// SourceDir is the skill bundle to copy — the repo's skills/novamem/.
	// Required; see the package note above.
	SourceDir string
}

// InstallSkill installs the skill bundle for a single tool.
func InstallSkill(tool ToolEntry, ctx Context, opts SkillInstallOptions) (SkillInstallResult, error) {
	if opts.SourceDir == "" {
		return SkillInstallResult{}, fmt.Errorf("skill source directory not set for %s", tool.ID)
	}
	if _, err := os.Stat(opts.SourceDir); err != nil {
		return SkillInstallResult{}, fmt.Errorf("skill source not found at %s: %w", opts.SourceDir, err)
	}
	destination := filepath.Join(RootFor(tool, ctx), tool.SkillsBase, "skills", "novamem")
	if opts.DryRun {
		return SkillInstallResult{ToolID: tool.ID, Destination: destination}, nil
	}
	// fileops.go's CopyDir is file-ops.ts's copyDir(): recursive,
	// idempotent (overwrites), and it skips symlinks exactly as the TS
	// version did by only recursing into isDirectory() entries and
	// copying isFile() ones.
	if err := CopyDir(opts.SourceDir, destination); err != nil {
		return SkillInstallResult{}, fmt.Errorf("copy skill bundle to %s: %w", destination, err)
	}
	return SkillInstallResult{ToolID: tool.ID, Destination: destination, Written: true}, nil
}
