package initcli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	testBaseURL = "https://memory.example.com"
	testBearer  = "nm_GOLDENFIXTURETOKEN"
	testShim    = "/opt/novamem/bin/novamem-mcp"
)

func testParams() McpInstallParams {
	return McpInstallParams{BaseURL: testBaseURL, Bearer: testBearer, ShimBinary: testShim}
}

func TestBuildMcpEntrySSE(t *testing.T) {
	// A trailing slash on the base URL must not produce "//mcp/sse".
	got := StringifyJSON(BuildMcpEntry(&McpAdapter{Path: ".mcp.json"}, McpInstallParams{
		BaseURL: testBaseURL + "/",
		Bearer:  testBearer,
	}))
	want := `{
  "type": "sse",
  "url": "https://memory.example.com/mcp/sse",
  "headers": {
    "Authorization": "Bearer nm_GOLDENFIXTURETOKEN"
  }
}
`
	if got != want {
		t.Fatalf("sse entry mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestBuildMcpEntryStdio(t *testing.T) {
	// ADR 0001: the command is the shipped binary, and there is no
	// "args" key at all — the npx spec it replaced is gone.
	got := StringifyJSON(BuildMcpEntry(&McpAdapter{Transport: "stdio"}, testParams()))
	want := `{
  "command": "/opt/novamem/bin/novamem-mcp",
  "env": {
    "NOVAMEM_BASE_URL": "https://memory.example.com",
    "NOVAMEM_TOKEN": "nm_GOLDENFIXTURETOKEN"
  }
}
`
	if got != want {
		t.Fatalf("stdio entry mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, `"args"`) {
		t.Error(`stdio entry still carries an "args" key; the npx spec was retired by ADR 0001`)
	}
}

func TestBuildMcpEntryStdioOpenCodeVariant(t *testing.T) {
	// OpenCode calls the env map "environment" and needs an explicit
	// type:"local" to recognise a stdio server. The type goes last,
	// after the env map — that order is what the fixtures pin.
	adapter := &McpAdapter{
		Transport:      "stdio",
		StdioEnvKey:    "environment",
		StdioTypeField: "local",
	}
	got := StringifyJSON(BuildMcpEntry(adapter, testParams()))
	want := `{
  "command": "/opt/novamem/bin/novamem-mcp",
  "environment": {
    "NOVAMEM_BASE_URL": "https://memory.example.com",
    "NOVAMEM_TOKEN": "nm_GOLDENFIXTURETOKEN"
  },
  "type": "local"
}
`
	if got != want {
		t.Fatalf("opencode stdio entry mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestInstallMcpNoAdapterIsSkipped(t *testing.T) {
	res, err := InstallMcp(ToolEntry{ID: "skill-only"}, Context{}, testParams(), false)
	if err != nil {
		t.Fatalf("InstallMcp: %v", err)
	}
	if !res.Skipped || res.Changed || res.Reason != "no MCP adapter for this tool" {
		t.Fatalf("unexpected result for a skill-only host: %+v", res)
	}
}

// sseTool is a minimal project-scoped host writing .mcp.json over SSE.
func sseTool() ToolEntry {
	return ToolEntry{
		ID:    "fake-host",
		Scope: ScopeProject,
		Mcp:   &McpAdapter{Path: ".mcp.json", Format: "json"},
	}
}

func TestInstallMcpMergePreservesForeignKeysInOrder(t *testing.T) {
	root := t.TempDir()
	// A user config that already has another MCP server and an
	// unrelated top-level key. Our entry must be appended AFTER the
	// user's server, and "editorSetting" must stay where it sat.
	existing := `{
  "mcpServers": {
    "other": {
      "type": "sse",
      "url": "https://other"
    }
  },
  "editorSetting": 42
}
`
	cfg := filepath.Join(root, ".mcp.json")
	if err := os.WriteFile(cfg, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := InstallMcp(sseTool(), Context{ProjectRoot: root}, testParams(), false)
	if err != nil {
		t.Fatalf("InstallMcp: %v", err)
	}
	if !res.Changed || res.Skipped {
		t.Fatalf("first install should have changed the file: %+v", res)
	}
	if res.ConfigPath != cfg {
		t.Errorf("ConfigPath = %q, want %q", res.ConfigPath, cfg)
	}

	got := readFile(t, cfg)
	want := `{
  "mcpServers": {
    "other": {
      "type": "sse",
      "url": "https://other"
    },
    "novamem": {
      "type": "sse",
      "url": "https://memory.example.com/mcp/sse",
      "headers": {
        "Authorization": "Bearer nm_GOLDENFIXTURETOKEN"
      }
    }
  },
  "editorSetting": 42
}
`
	if got != want {
		t.Fatalf("merged config mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestInstallMcpIsIdempotent(t *testing.T) {
	root := t.TempDir()
	tool := sseTool()
	ctx := Context{ProjectRoot: root}

	first, err := InstallMcp(tool, ctx, testParams(), false)
	if err != nil {
		t.Fatalf("first InstallMcp: %v", err)
	}
	if !first.Changed {
		t.Fatal("first install reported no change")
	}
	after := readFile(t, first.ConfigPath)

	second, err := InstallMcp(tool, ctx, testParams(), false)
	if err != nil {
		t.Fatalf("second InstallMcp: %v", err)
	}
	if second.Changed || second.Skipped {
		t.Fatalf("second install should be a no-op, got %+v", second)
	}
	if again := readFile(t, first.ConfigPath); again != after {
		t.Fatalf("second install rewrote the file:\nbefore:\n%s\nafter:\n%s", after, again)
	}
}

func TestInstallMcpDryRunWritesNothing(t *testing.T) {
	root := t.TempDir()
	res, err := InstallMcp(sseTool(), Context{ProjectRoot: root}, testParams(), true)
	if err != nil {
		t.Fatalf("InstallMcp: %v", err)
	}
	if !res.Changed || !res.Skipped || res.Reason != "dry-run" {
		t.Fatalf("unexpected dry-run result: %+v", res)
	}
	if _, err := os.Stat(res.ConfigPath); !os.IsNotExist(err) {
		t.Fatalf("dry-run created %s", res.ConfigPath)
	}
}

func TestInstallMcpTomlRoundTrip(t *testing.T) {
	root := t.TempDir()
	tool := ToolEntry{
		ID:    "codex",
		Scope: ScopeUser,
		Mcp: &McpAdapter{
			Path:      ".codex/config.toml",
			Format:    "toml",
			RootKey:   "mcp_servers",
			Transport: "stdio",
		},
	}
	ctx := Context{Home: root}
	cfg := filepath.Join(root, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg, []byte("model = \"gpt-5\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := InstallMcp(tool, ctx, testParams(), false); err != nil {
		t.Fatalf("InstallMcp: %v", err)
	}
	got := readFile(t, cfg)
	for _, want := range []string{
		`model = 'gpt-5'`,
		`[mcp_servers.novamem]`,
		`command = '/opt/novamem/bin/novamem-mcp'`,
		`NOVAMEM_TOKEN = 'nm_GOLDENFIXTURETOKEN'`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("TOML config is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "args") {
		t.Errorf("TOML stdio entry still carries args:\n%s", got)
	}

	// And the same idempotency guarantee as the JSON path.
	second, err := InstallMcp(tool, ctx, testParams(), false)
	if err != nil {
		t.Fatalf("second InstallMcp: %v", err)
	}
	if second.Changed {
		t.Fatalf("second TOML install should be a no-op, got %+v", second)
	}
}

func TestResolveShimBinaryPrecedence(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission-bit fakes are POSIX-only")
	}
	name := shimBinaryName()

	sibDir := t.TempDir()
	pathDir := t.TempDir()
	sibling := filepath.Join(sibDir, name)
	onPath := filepath.Join(pathDir, name)
	writeFakeBinary(t, sibling)
	writeFakeBinary(t, onPath)

	// Pretend our own executable lives next to the sibling fake.
	saved := executablePath
	t.Cleanup(func() { executablePath = saved })
	executablePath = func() (string, error) { return filepath.Join(sibDir, "novamem-init"), nil }
	t.Setenv("PATH", pathDir)

	// 1. An explicit override wins over both.
	explicit := filepath.Join(t.TempDir(), "custom-shim")
	got, err := ResolveShimBinary(explicit)
	if err != nil {
		t.Fatalf("explicit: %v", err)
	}
	if got != explicit {
		t.Errorf("explicit override = %q, want %q", got, explicit)
	}

	// 2. With no override, the sibling of the running binary wins over PATH.
	got, err = ResolveShimBinary("")
	if err != nil {
		t.Fatalf("sibling: %v", err)
	}
	if got != sibling {
		t.Errorf("sibling lookup = %q, want %q", got, sibling)
	}

	// 3. With no sibling, PATH is the last resort.
	if err := os.Remove(sibling); err != nil {
		t.Fatal(err)
	}
	got, err = ResolveShimBinary("")
	if err != nil {
		t.Fatalf("PATH: %v", err)
	}
	if got != onPath {
		t.Errorf("PATH lookup = %q, want %q", got, onPath)
	}

	// 4. Nothing anywhere is a clear error naming all three routes.
	if err := os.Remove(onPath); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveShimBinary(""); err == nil {
		t.Fatal("expected an error when the shim is nowhere to be found")
	} else {
		for _, frag := range []string{"NOVAMEM_MCP_BIN", "next to this executable", "PATH"} {
			if !strings.Contains(err.Error(), frag) {
				t.Errorf("error %q does not mention %q", err, frag)
			}
		}
	}
}

func TestResolveShimBinaryIgnoresNonExecutableSibling(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission-bit fakes are POSIX-only")
	}
	sibDir := t.TempDir()
	// A non-executable file with the right name must not be selected;
	// that is exactly the config-pointing-at-a-dead-shim bug class.
	if err := os.WriteFile(filepath.Join(sibDir, shimBinaryName()), []byte("not a program"), 0o600); err != nil {
		t.Fatal(err)
	}
	saved := executablePath
	t.Cleanup(func() { executablePath = saved })
	executablePath = func() (string, error) { return filepath.Join(sibDir, "novamem-init"), nil }
	t.Setenv("PATH", t.TempDir())

	if got, err := ResolveShimBinary(""); err == nil {
		t.Fatalf("selected a non-executable sibling: %q", got)
	}
}

func TestVerifyShimBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fakes are POSIX-only")
	}
	dir := t.TempDir()

	missing := filepath.Join(dir, "absent")
	if err := VerifyShimBinary(missing); err == nil {
		t.Error("a missing shim should not verify")
	}

	dud := filepath.Join(dir, "dud")
	if err := os.WriteFile(dud, []byte("#!/bin/sh\nexit 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyShimBinary(dud); err == nil {
		t.Error("a non-executable shim should not verify")
	}

	// A script that exits cleanly on stdin EOF — the healthy shape.
	ok := filepath.Join(dir, "ok")
	writeScript(t, ok, "#!/bin/sh\ncat >/dev/null\nexit 0\n")
	if err := VerifyShimBinary(ok); err != nil {
		t.Errorf("a clean-exiting shim should verify: %v", err)
	}

	// A script that crashes on startup — the bug class this guards.
	crash := filepath.Join(dir, "crash")
	writeScript(t, crash, "#!/bin/sh\necho 'boom: cannot load module' >&2\nexit 3\n")
	err := VerifyShimBinary(crash)
	if err == nil {
		t.Fatal("a crashing shim should not verify")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error should surface the shim's stderr, got: %v", err)
	}
}

func writeFakeBinary(t *testing.T, path string) {
	t.Helper()
	writeScript(t, path, "#!/bin/sh\nexit 0\n")
}

func writeScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path) //nolint:gosec // test-owned temp path
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
