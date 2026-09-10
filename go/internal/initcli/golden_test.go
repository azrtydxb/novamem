package initcli

// Integration parity: what this installer writes must match what the
// retired TypeScript installer wrote, for every host in the registry.
//
// testdata/golden.json is the TypeScript output (see the README there).
// It is NOT regenerated to match Go — that would turn the oracle into a
// mirror. Instead the ONE sanctioned difference is applied to the
// EXPECTATION: per ADR 0001 a stdio entry names the shipped novamem-mcp
// binary instead of `npx -y @azrtydxb/novamem-mcp@<version>`, so the
// expected entry has its command swapped and its args dropped. Anything
// else differing is a regression.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
)

const (
	goldenBaseURL = "https://memory.example.com"
	goldenBearer  = "nm_GOLDENFIXTURETOKEN"
	// The path a resolved shim would have. Only its presence in the
	// written config matters, so it need not exist.
	goldenShim = "/opt/novamem/bin/novamem-mcp"
)

// goldenTool and loadGolden live in commands_test.go — one
// declaration for the whole package.

func goldenParams() McpInstallParams {
	return McpInstallParams{BaseURL: goldenBaseURL, Bearer: goldenBearer, ShimBinary: goldenShim}
}

// priorConfig rebuilds the pre-existing file the fixture generator wrote
// before its second install: a foreign server under the host's own root
// key, plus an unrelated top-level setting. Reproducing it is what makes
// the comparison a merge test rather than a fresh-write test.
func priorConfig(rootKey string) string {
	doc := NewDoc()
	servers := NewDoc()
	other := NewDoc()
	other.Set("type", "sse")
	other.Set("url", "https://other")
	servers.Set("other", other)
	doc.Set(rootKey, servers)
	doc.Set("editorSetting", json.Number("42"))
	return StringifyJSON(doc)
}

// expectedJSON takes the TypeScript fixture and applies only the
// ADR-0001 substitution, failing loudly if a stdio fixture no longer
// looks like the npx form it is supposed to replace.
func expectedJSON(t *testing.T, tool ToolEntry, fixture string) string {
	t.Helper()
	doc := ParseJSONLoose(fixture)
	entry, ok := doc.DeepGet([]string{tool.Mcp.RootKeyOrDefault(), tool.Mcp.ServerKeyOrDefault()}).(*Doc)
	if !ok {
		t.Fatalf("%s: fixture has no %s.%s entry", tool.ID,
			tool.Mcp.RootKeyOrDefault(), tool.Mcp.ServerKeyOrDefault())
	}
	if tool.Mcp.TransportOrDefault() != "stdio" {
		return StringifyJSON(doc) // sse entries are unchanged by the ADR
	}
	if cmd, _ := entry.Get("command"); cmd != "npx" {
		t.Fatalf("%s: stdio fixture command is %v, expected the npx form the ADR replaces", tool.ID, cmd)
	}
	if _, hasArgs := entry.Get("args"); !hasArgs {
		t.Fatalf("%s: stdio fixture has no args to drop", tool.ID)
	}
	entry.Set("command", goldenShim) // Set keeps the key's original position
	entry.Delete("args")
	return StringifyJSON(doc)
}

func TestInstallMcpMatchesTypeScriptOutput(t *testing.T) {
	golden := loadGolden(t)
	checked := 0
	for _, tool := range Tools {
		if tool.Mcp == nil {
			continue
		}
		t.Run(tool.ID, func(t *testing.T) {
			fixture, ok := golden[tool.ID]
			if !ok {
				t.Fatalf("no fixture for %s", tool.ID)
			}
			want, ok := fixture.Files[tool.Mcp.Path]
			if !ok {
				t.Fatalf("fixture for %s has no %s", tool.ID, tool.Mcp.Path)
			}

			dir := t.TempDir()
			ctx := Context{ProjectRoot: dir, Home: dir}
			configPath := filepath.Join(dir, tool.Mcp.Path)

			if _, err := InstallMcp(tool, ctx, goldenParams(), false); err != nil {
				t.Fatalf("first install: %v", err)
			}
			if tool.Mcp.Format == "json" {
				// Same second pass the generator ran: drop a config that
				// already has a foreign server, then merge into it.
				if err := WriteFileEnsureDir(configPath, priorConfig(tool.Mcp.RootKeyOrDefault())); err != nil {
					t.Fatal(err)
				}
				if _, err := InstallMcp(tool, ctx, goldenParams(), false); err != nil {
					t.Fatalf("merge install: %v", err)
				}
			}

			gotBytes, err := os.ReadFile(configPath)
			if err != nil {
				t.Fatal(err)
			}
			got := string(gotBytes)

			if tool.Mcp.Format == "toml" {
				// TOML is compared semantically: go-toml and smol-toml
				// disagree on quoting and key order, and neither host nor
				// user can observe that difference. Structure and
				// preservation are the contract.
				assertTomlEquivalent(t, want, got)
				checked++
				return
			}
			if got != expectedJSON(t, tool, want) {
				t.Errorf("%s config differs.\n--- want ---\n%s\n--- got ---\n%s",
					tool.ID, expectedJSON(t, tool, want), got)
			}
			checked++

			// Re-running must be a no-op: the installer is expected to be
			// idempotent, and a user's file must not churn on every run.
			res, err := InstallMcp(tool, ctx, goldenParams(), false)
			if err != nil {
				t.Fatalf("idempotency install: %v", err)
			}
			again, err := os.ReadFile(configPath)
			if err != nil {
				t.Fatal(err)
			}
			if string(again) != got {
				t.Errorf("%s: second run rewrote the config", tool.ID)
			}
			if res.Changed {
				t.Errorf("%s: second run reported Changed, want in-sync", tool.ID)
			}
		})
	}
	if checked == 0 {
		t.Fatal("no MCP hosts exercised")
	}
}

// assertTomlEquivalent compares a TypeScript TOML fixture with our
// output after applying the ADR-0001 substitution to the expectation.
func assertTomlEquivalent(t *testing.T, want, got string) {
	t.Helper()
	var w, g map[string]any
	if err := toml.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("fixture is not valid TOML: %v", err)
	}
	if err := toml.Unmarshal([]byte(got), &g); err != nil {
		t.Fatalf("our output is not valid TOML: %v", err)
	}
	servers, _ := w["mcp_servers"].(map[string]any)
	entry, _ := servers["novamem"].(map[string]any)
	if entry == nil {
		t.Fatal("fixture has no mcp_servers.novamem table")
	}
	if entry["command"] != "npx" {
		t.Fatalf("stdio fixture command is %v, expected the npx form the ADR replaces", entry["command"])
	}
	entry["command"] = goldenShim
	delete(entry, "args")

	wantJSON, _ := json.Marshal(w)
	gotJSON, _ := json.Marshal(g)
	if string(wantJSON) != string(gotJSON) {
		t.Errorf("TOML structures differ.\n--- want ---\n%s\n--- got ---\n%s", wantJSON, gotJSON)
	}
}

// Regression, novamem 1.1.2: the installer configured Claude Desktop
// with {"type":"sse", url, headers}, which its loader rejects on launch
// ("not valid MCP server configurations and were skipped: novamem") —
// it accepts stdio entries only. The fix was to give that host a stdio
// transport, and this pins it: Claude Desktop must get a command-based
// entry with no url, whatever else changes in the registry.
func TestClaudeDesktopStaysStdio(t *testing.T) {
	tool := FindTool("claude-desktop")
	if tool == nil {
		t.Fatal("claude-desktop is missing from the registry")
	}
	if got := tool.Mcp.TransportOrDefault(); got != "stdio" {
		t.Fatalf("transport = %q, want stdio — Claude Desktop's loader refuses sse entries", got)
	}

	dir := t.TempDir()
	ctx := Context{ProjectRoot: dir, Home: dir}
	if _, err := InstallMcp(*tool, ctx, goldenParams(), false); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, tool.Mcp.Path))
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := ParseJSONLoose(string(raw)).
		DeepGet([]string{tool.Mcp.RootKeyOrDefault(), tool.Mcp.ServerKeyOrDefault()}).(*Doc)
	if !ok {
		t.Fatalf("no server entry written:\n%s", raw)
	}
	if cmd, _ := entry.Get("command"); cmd != goldenShim {
		t.Errorf("command = %v, want the shim binary %q", cmd, goldenShim)
	}
	if _, hasURL := entry.Get("url"); hasURL {
		t.Error("entry carries a url — that is the sse shape 1.1.2 shipped by mistake")
	}
	if typ, has := entry.Get("type"); has && typ == "sse" {
		t.Error(`entry declares type "sse"`)
	}
}
