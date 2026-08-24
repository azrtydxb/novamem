package initcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// goldenTool is one entry of testdata/golden.json: fixtures captured
// from the TypeScript installer before it was retired.
type goldenTool struct {
	Tool  string            `json:"tool"`
	Files map[string]string `json:"files"`
}

func loadGolden(t *testing.T) map[string]goldenTool {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatalf("read golden.json: %v", err)
	}
	var out map[string]goldenTool
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("parse golden.json: %v", err)
	}
	return out
}

// commandSourceDir is the repo's integrations/claude-code/commands/,
// which is what the installer copies from now that there is no build
// step staging the files into a dist/assets tree.
func commandSourceDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join("..", "..", "..", "integrations", "claude-code", "commands")
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("command sources missing at %s: %v", dir, err)
	}
	return dir
}

// commandHosts pins the adapter for every command-capable host that has
// fixtures. They are spelled out here rather than read from the registry
// so this test fails when the RENDERER drifts, not when the registry is
// edited — and so it does not depend on another module's file.
var commandHosts = map[string]CommandAdapter{
	"claude-code":    {Dir: ".claude/commands", Format: "claude-md"},
	"opencode":       {Dir: ".opencode/commands", Format: "claude-md"},
	"codex":          {Dir: ".codex/prompts", Format: "claude-md", Prefix: "memory-"},
	"continue":       {Dir: ".continue/prompts", Format: "continue-prompt"},
	"github-copilot": {Dir: ".github/prompts", Format: "github-prompt-md"},
	"gemini":         {Dir: ".gemini/commands", Format: "gemini-toml"},
}

// TestInstallCommandsMatchesGolden renders every command fixture for
// every command-capable host and asserts byte equality with the output
// the TypeScript installer produced.
func TestInstallCommandsMatchesGolden(t *testing.T) {
	golden := loadGolden(t)
	sourceDir := commandSourceDir(t)

	for toolID, adapter := range commandHosts {
		t.Run(toolID, func(t *testing.T) {
			fixture, ok := golden[toolID]
			if !ok {
				t.Fatalf("no golden fixture for %s", toolID)
			}
			// Only the files under this host's command directory are ours;
			// the MCP config in the same fixture belongs to another module.
			want := map[string]string{}
			for path, content := range fixture.Files {
				if strings.HasPrefix(path, adapter.Dir+"/") {
					want[path] = content
				}
			}
			if len(want) == 0 {
				t.Fatalf("golden fixture for %s has no files under %s", toolID, adapter.Dir)
			}

			root := t.TempDir()
			tool := ToolEntry{
				ID:       toolID,
				Scope:    ScopeProject,
				Commands: &adapter,
			}
			res, err := InstallCommands(tool, Context{ProjectRoot: root, Home: root},
				CommandInstallOptions{SourceDir: sourceDir})
			if err != nil {
				t.Fatalf("InstallCommands: %v", err)
			}
			if res.Skipped {
				t.Fatalf("unexpectedly skipped: %s", res.Reason)
			}
			if len(res.FilesWritten) != len(want) {
				t.Fatalf("wrote %d files, golden has %d", len(res.FilesWritten), len(want))
			}

			for path, wantContent := range want {
				got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
				if err != nil {
					t.Fatalf("%s: %v", path, err)
				}
				if string(got) != wantContent {
					t.Errorf("%s: rendered bytes differ from golden\n got: %q\nwant: %q",
						path, truncate(string(got)), truncate(wantContent))
				}
			}
		})
	}
}

func truncate(s string) string {
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}

// TestDestFilename covers the prefix rule and every format's extension.
func TestDestFilename(t *testing.T) {
	cases := []struct {
		name    string
		src     string
		adapter CommandAdapter
		want    string
	}{
		{"claude-md", "recall.md", CommandAdapter{Format: "claude-md"}, "recall.md"},
		{"prefixed", "recall.md", CommandAdapter{Format: "claude-md", Prefix: "memory-"}, "memory-recall.md"},
		{"prefix applies before the extension", "memory-stats.md",
			CommandAdapter{Format: "claude-md", Prefix: "memory-"}, "memory-memory-stats.md"},
		{"continue", "recall.md", CommandAdapter{Format: "continue-prompt"}, "recall.prompt"},
		{"copilot", "recall.md", CommandAdapter{Format: "github-prompt-md"}, "recall.prompt.md"},
		{"copilot prefixed", "recall.md",
			CommandAdapter{Format: "github-prompt-md", Prefix: "memory-"}, "memory-recall.prompt.md"},
		{"gemini", "recall.md", CommandAdapter{Format: "gemini-toml"}, "recall.toml"},
		{"basename of a path", filepath.Join("a", "b", "today.md"),
			CommandAdapter{Format: "claude-md"}, "today.md"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DestFilename(tc.src, tc.adapter)
			if err != nil {
				t.Fatalf("DestFilename: %v", err)
			}
			if got != tc.want {
				t.Errorf("DestFilename(%q) = %q, want %q", tc.src, got, tc.want)
			}
		})
	}

	if _, err := DestFilename("recall.md", CommandAdapter{Format: "nope"}); err == nil {
		t.Error("expected an error for an unknown format")
	}
}

// TestParseCommandFile covers the shapes the fixtures do not: files with
// no frontmatter, an unterminated block, and a repeated key.
func TestParseCommandFile(t *testing.T) {
	if got := ParseCommandFile("no frontmatter\nhere"); got.Body != "no frontmatter\nhere" || len(got.Frontmatter) != 0 {
		t.Errorf("plain body: %#v", got)
	}
	if got := ParseCommandFile("---\ndescription: x\nbody"); got.Body != "---\ndescription: x\nbody" {
		t.Errorf("unterminated frontmatter should be returned whole: %q", got.Body)
	}
	got := ParseCommandFile("---\r\ndescription: a\r\nargument-hint: <q>\r\ndescription: b\r\n---\r\n\r\nbody\r\n")
	if len(got.Frontmatter) != 2 ||
		got.Frontmatter[0] != (CommandField{Key: "description", Value: "b"}) ||
		got.Frontmatter[1] != (CommandField{Key: "argument-hint", Value: "<q>"}) {
		t.Errorf("a repeated key must overwrite in place: %#v", got.Frontmatter)
	}
	if got.Body != "body\n" {
		t.Errorf("body = %q", got.Body)
	}
}
