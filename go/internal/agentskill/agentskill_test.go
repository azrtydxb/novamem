package agentskill

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func repoRoot() string { return filepath.Join("..", "..", "..") }

// The embedded skill is a copy of the repo's skills/novamem/, which is
// what an installer ships and what docs link to. Re-sync with:
//
//	rsync -a --delete skills/novamem/ go/internal/agentskill/skill/
func TestEmbeddedSkillMatchesRepoSource(t *testing.T) {
	src := filepath.Join(repoRoot(), "skills", "novamem")
	if _, err := os.Stat(src); err != nil {
		t.Skipf("repo sources unavailable (%v) — drift check needs a checkout", err)
	}
	embedded, err := FS()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	err = filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		seen[rel] = true
		want, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		got, err := os.ReadFile(filepath.Join("skill", rel))
		if err != nil {
			t.Errorf("%s is in skills/novamem but not embedded: %v", rel, err)
			return nil
		}
		if string(got) != string(want) {
			t.Errorf("%s differs from skills/novamem — re-sync (see doc comment)", rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = embedded
}

// The instructions must render, and must carry the parts the server and
// its adoption report depend on. A marker accidentally deleted would
// otherwise ship a server that tells agents nothing.
func TestInstructionsRender(t *testing.T) {
	got, err := Instructions()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"# novamem",
		"## Mandatory memory protocol",
		"memory_context",
		"memory_capture",
		"## Project scope",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("instructions are missing %q", want)
		}
	}
	// Skill-only material must not reach the wire: the front matter is
	// installer metadata, and the note about the skill/instructions
	// split would be self-referential in the instructions themselves.
	for _, unwanted := range []string{
		"license: Apache-2.0",
		"this skill is the equivalent for clients",
		markerStart,
		markerEnd,
	} {
		if strings.Contains(got, unwanted) {
			t.Errorf("instructions leaked skill-only content %q", unwanted)
		}
	}
	// Repo-relative links mean nothing to a client that only got the
	// text over the wire.
	if strings.Contains(got, "](references/") || strings.Contains(got, "](./") {
		t.Error("instructions still contain repo-relative markdown links")
	}
}

// Every advertised MCP tool must be documented in the skill, and the
// skill must not describe a tool that no longer exists. This is the
// check that catches a tool being added or renamed without the
// agent-facing docs following.
func TestSkillDocumentsExactlyTheAdvertisedTools(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot(), "go", "internal", "mcp", "tooldefs.json"))
	if err != nil {
		t.Skipf("tooldefs unavailable (%v)", err)
	}
	var defs []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &defs); err != nil {
		t.Fatal(err)
	}
	md, err := Markdown()
	if err != nil {
		t.Fatal(err)
	}
	skill := string(md)
	for _, d := range defs {
		if !strings.Contains(skill, d.Name) {
			t.Errorf("tool %q is advertised over MCP but absent from SKILL.md", d.Name)
		}
	}
	// The reverse: a tool named in the skill that no longer exists sends
	// agents after something that will fail.
	advertised := map[string]bool{}
	for _, d := range defs {
		advertised[d.Name] = true
	}
	for _, tok := range toolLikeTokens(skill) {
		if !advertised[tok] {
			t.Errorf("SKILL.md documents %q, which is not an advertised MCP tool", tok)
		}
	}
}

// toolLikeTokens finds `memory_*` / `project_*` identifiers in the
// document — the shape every tool name in this surface has.
func toolLikeTokens(doc string) []string {
	seen := map[string]bool{}
	var out []string
	for _, field := range strings.FieldsFunc(doc, func(r rune) bool {
		return !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9')
	}) {
		var suffix string
		switch {
		case strings.HasPrefix(field, "memory_"):
			suffix = strings.TrimPrefix(field, "memory_")
		case strings.HasPrefix(field, "project_"):
			suffix = strings.TrimPrefix(field, "project_")
		default:
			continue
		}
		// `memory_*` in prose splits to a bare prefix — a wildcard, not
		// a tool name.
		if suffix == "" {
			continue
		}
		if seen[field] {
			continue
		}
		seen[field] = true
		out = append(out, field)
	}
	return out
}

func TestExtractMarkedRejectsMalformedMarkers(t *testing.T) {
	cases := map[string]string{
		"unclosed":  markerStart + "\nbody\n",
		"unopened":  "body\n" + markerEnd + "\n",
		"nested":    markerStart + "\na\n" + markerStart + "\nb\n" + markerEnd + "\n",
		"no region": "# just a document\n",
	}
	for name, doc := range cases {
		if _, err := extractMarked(doc); err == nil {
			t.Errorf("%s: want an error, got none", name)
		}
	}
	got, err := extractMarked("skip\n" + markerStart + "\nkeep\n" + markerEnd + "\nskip\n")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(got) != "keep" {
		t.Errorf("extract = %q, want %q", got, "keep")
	}
}
