package initcli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The skill and the commands come from two different embedded trees
// (the skill lives in agentskill so the MCP server can render its
// instructions from the same file). A binary with no checkout beside it
// still has to stage a complete bundle.
func TestMaterializeAssetsStagesBothTrees(t *testing.T) {
	dir := t.TempDir()
	skillDir, commandsDir, err := MaterializeAssets(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		filepath.Join(skillDir, "SKILL.md"),
		filepath.Join(skillDir, "references", "search.md"),
		filepath.Join(skillDir, "references", "remember.md"),
		filepath.Join(skillDir, "references", "projects.md"),
	} {
		st, err := os.Stat(want)
		if err != nil {
			t.Errorf("missing from the staged skill: %s (%v)", want, err)
			continue
		}
		if st.Size() == 0 {
			t.Errorf("staged empty: %s", want)
		}
	}
	entries, err := os.ReadDir(commandsDir)
	if err != nil || len(entries) == 0 {
		t.Errorf("commands not staged: %d entries, %v", len(entries), err)
	}
	// The staged skill must be the real thing, not a placeholder.
	body, err := os.ReadFile(filepath.Join(skillDir, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "## Mandatory memory protocol") {
		t.Error("staged SKILL.md does not contain the mandatory protocol")
	}
}

// The transport each target gets is a deliberate choice, not an
// accident of copy-paste. Pinning it here means changing one is a
// visible edit to this table rather than a silent change in what every
// new install connects to.
//
// They said "sse" until ADR 0007 — the HTTP+SSE transport from revision
// 2024-11-05, which the spec Deprecated and the server no longer serves.
// Every install the old value produced pointed at a transport on its way
// out (#267). "sse" is no longer an accepted value below, so it cannot
// come back by copy-paste.
func TestMcpTransportPerTarget(t *testing.T) {
	want := map[string]string{
		"claude-code": "http",
		"cursor":      "http",
		"kilocode":    "http",
	}
	got := map[string]string{}
	for _, tool := range Tools {
		if tool.Mcp == nil {
			continue
		}
		got[tool.ID] = tool.Mcp.Transport
	}
	for id, wantTransport := range want {
		if got[id] != wantTransport {
			t.Errorf("%s MCP transport = %q, want %q — if this is the #267 fix, update this table too",
				id, got[id], wantTransport)
		}
	}
	for id, transport := range got {
		switch transport {
		case "http", "stdio":
		default:
			t.Errorf("%s has unknown MCP transport %q", id, transport)
		}
	}
}
