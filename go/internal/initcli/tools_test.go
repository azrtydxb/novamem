package initcli

import "testing"

// The registry is a transcription of packages/init/src/tools.ts. These
// counts are the tripwire: if a row is dropped, duplicated, or loses its
// mcp/commands adapter during a future edit, one of these numbers moves.
func TestRegistryShape(t *testing.T) {
	if len(Tools) != 30 {
		t.Fatalf("registry has %d entries, want 30", len(Tools))
	}

	seen := make(map[string]bool, len(Tools))
	for i, tool := range Tools {
		if tool.ID == "" {
			t.Errorf("entry %d has an empty id", i)
			continue
		}
		if seen[tool.ID] {
			t.Errorf("duplicate id %q", tool.ID)
		}
		seen[tool.ID] = true

		if tool.Name == "" {
			t.Errorf("%s: empty name", tool.ID)
		}
		if tool.Scope != ScopeProject && tool.Scope != ScopeUser {
			t.Errorf("%s: bad scope %q", tool.ID, tool.Scope)
		}
		if tool.SkillsBase == "" {
			t.Errorf("%s: empty skillsBase", tool.ID)
		}
		if len(tool.Detect) == 0 {
			t.Errorf("%s: no detect paths", tool.ID)
		}
	}
}

func TestCapabilityCounts(t *testing.T) {
	var mcpJSON, mcpTOML, commands int
	for _, tool := range Tools {
		if tool.Mcp != nil {
			switch tool.Mcp.Format {
			case "json":
				mcpJSON++
			case "toml":
				mcpTOML++
			default:
				t.Errorf("%s: unknown mcp format %q", tool.ID, tool.Mcp.Format)
			}
			if tool.Mcp.Path == "" {
				t.Errorf("%s: mcp adapter with no path", tool.ID)
			}
		}
		if tool.Commands != nil {
			commands++
			if tool.Commands.Dir == "" || tool.Commands.Format == "" {
				t.Errorf("%s: incomplete command adapter", tool.ID)
			}
		}
	}

	if got, want := mcpJSON+mcpTOML, 8; got != want {
		t.Errorf("mcp-capable hosts = %d, want %d", got, want)
	}
	if mcpJSON != 7 {
		t.Errorf("json mcp hosts = %d, want 7", mcpJSON)
	}
	if mcpTOML != 1 {
		t.Errorf("toml mcp hosts = %d, want 1", mcpTOML)
	}
	if commands != 13 {
		t.Errorf("command-capable hosts = %d, want 13", commands)
	}
}

func TestFindTool(t *testing.T) {
	got := FindTool("codex")
	if got == nil {
		t.Fatal("FindTool(codex) = nil")
	}
	if got.Mcp == nil || got.Mcp.Format != "toml" || got.Mcp.RootKey != "mcp_servers" {
		t.Errorf("codex mcp adapter = %+v", got.Mcp)
	}
	if FindTool("nope") != nil {
		t.Error("FindTool(nope) should be nil")
	}
}

// Sparse rows rely on the *OrDefault accessors rather than repeating the
// defaults in every row; check both a defaulted and an overriding host.
func TestAdapterDefaultsApply(t *testing.T) {
	cc := FindTool("claude-code")
	if cc == nil {
		t.Fatal("claude-code missing")
	}
	if got := cc.Mcp.RootKeyOrDefault(); got != "mcpServers" {
		t.Errorf("claude-code rootKey = %q, want mcpServers", got)
	}
	if got := cc.Mcp.ServerKeyOrDefault(); got != "novamem" {
		t.Errorf("claude-code serverKey = %q, want novamem", got)
	}
	if got := cc.Mcp.StdioEnvKeyOrDefault(); got != "env" {
		t.Errorf("claude-code stdioEnvKey = %q, want env", got)
	}

	oc := FindTool("opencode")
	if oc == nil {
		t.Fatal("opencode missing")
	}
	if got := oc.Mcp.RootKeyOrDefault(); got != "mcp" {
		t.Errorf("opencode rootKey = %q, want mcp", got)
	}
	if got := oc.Mcp.StdioEnvKeyOrDefault(); got != "environment" {
		t.Errorf("opencode stdioEnvKey = %q, want environment", got)
	}
	if oc.Mcp.StdioTypeField != "local" {
		t.Errorf("opencode stdioTypeField = %q, want local", oc.Mcp.StdioTypeField)
	}
	if got := oc.Mcp.TransportOrDefault(); got != "stdio" {
		t.Errorf("opencode transport = %q, want stdio", got)
	}
}
