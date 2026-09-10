package initcli

// Detect which configured AI tools are present on the user's machine by
// probing each tool's Detect paths against the project root or $HOME,
// depending on its scope.

import (
	"os"
	"path/filepath"
)

// DefaultContext resolves the project root to the current working
// directory and the home scope to the user's home directory. Both
// lookups are best-effort: a failure leaves the field empty, which makes
// every probe resolve relative to "" and simply detect nothing, rather
// than aborting the install.
func DefaultContext() Context {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return Context{ProjectRoot: cwd, Home: home}
}

// IsInstalled reports whether any of tool.Detect exists under the tool's
// scope root.
func IsInstalled(tool ToolEntry, ctx Context) bool {
	root := RootFor(tool, ctx)
	for _, probe := range tool.Detect {
		if Exists(filepath.Join(root, probe)) {
			return true
		}
	}
	return false
}

// DetectAll walks the registry and returns every tool that looks
// installed, in registry order.
func DetectAll(ctx Context) []ToolEntry {
	out := []ToolEntry{}
	for _, tool := range Tools {
		if IsInstalled(tool, ctx) {
			out = append(out, tool)
		}
	}
	return out
}
