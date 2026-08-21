package initcli

// MCP installer — writes a `novamem` server entry into each MCP-capable
// host's config file, idempotently merging with whatever the user already
// has there. Supports the two on-disk formats we know: JSON (most hosts)
// and TOML (Codex CLI).
//
// Transports:
//   - sse:   { type: "sse", url, headers: { Authorization: "Bearer nm_..." } }
//   - stdio: { command: "<novamem-mcp binary>", env: { ... } }
//
// The stdio shape is the one deliberate divergence from the TypeScript
// original (ADR 0001 — Go tools ship as GitHub-release binaries and npm
// is no longer a distribution channel). The TS installer wrote
// {"command":"npx","args":["-y","@azrtydxb/novamem-mcp@<version>"], ...}
// and pinned the shim version so a v1.1.3 init could not pull a v1.1.5
// shim with a different protocol. That pinning problem disappears with
// binaries: the shim ships in the same release archive as this
// installer, so we resolve it on disk and write its absolute path with
// no `args` at all. Everything else — key order, the env map, the
// optional `type` field, the SSE entry — is unchanged.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	toml "github.com/pelletier/go-toml/v2"
)

// McpInstallParams is everything an entry needs that does not come from
// the registry.
type McpInstallParams struct {
	BaseURL string
	Bearer  string
	// ShimBinary is the absolute path to the `novamem-mcp` executable to
	// name in stdio entries. Callers get it from ResolveShimBinary.
	// Replaces the TS `shimVersion` field: there is no npm spec to pin
	// any more, only a binary that ships alongside us.
	ShimBinary string
}

// McpInstallResult reports what InstallMcp did to one host.
type McpInstallResult struct {
	ToolID string
	// ConfigPath is the absolute path of the config file we wrote.
	ConfigPath string
	// Changed is true if our entry was newly added or changed; false if
	// already in sync.
	Changed bool
	// Skipped is true if no write happened (dry-run, or no MCP adapter
	// for the tool).
	Skipped bool
	Reason  string
}

// BuildMcpEntry builds the MCP server entry from the params + adapter.
// The result is an ordered *Doc because the key order it produces is
// what the golden fixtures pin.
func BuildMcpEntry(adapter *McpAdapter, p McpInstallParams) *Doc {
	entry := NewDoc()
	if adapter.TransportOrDefault() == "sse" {
		headers := NewDoc()
		headers.Set("Authorization", "Bearer "+p.Bearer)
		entry.Set("type", "sse")
		entry.Set("url", trimTrailingSlash(p.BaseURL)+"/mcp/sse")
		entry.Set("headers", headers)
		return entry
	}

	// stdio fallback for hosts that cannot speak SSE. Per ADR 0001 the
	// command is the shipped binary rather than `npx -y
	// @azrtydxb/novamem-mcp@<version>`, so there is no `args` key.
	env := NewDoc()
	env.Set("NOVAMEM_BASE_URL", trimTrailingSlash(p.BaseURL))
	env.Set("NOVAMEM_TOKEN", p.Bearer)
	entry.Set("command", p.ShimBinary)
	entry.Set(adapter.StdioEnvKeyOrDefault(), env)

	// Hosts like OpenCode require an explicit `type: "local"` to identify
	// stdio servers. Inject when the adapter declares it; omit otherwise
	// (Claude Desktop / Codex parse fine without it).
	if adapter.StdioTypeField != "" {
		entry.Set("type", adapter.StdioTypeField)
	}
	return entry
}

// shimBinaryName is the executable we look for. Windows release archives
// carry the .exe suffix.
func shimBinaryName() string {
	if runtime.GOOS == "windows" {
		return "novamem-mcp.exe"
	}
	return "novamem-mcp"
}

// executablePath is os.Executable behind a variable so tests can point
// the "next to the running binary" probe at a temp directory.
var executablePath = os.Executable

// ResolveShimBinary finds the `novamem-mcp` stdio shim to name in stdio
// MCP entries, in this order:
//
//  1. explicit — whatever the caller passed (the --mcp-bin flag or the
//     NOVAMEM_MCP_BIN environment variable). An explicit choice always
//     wins; we do not second-guess it.
//  2. a `novamem-mcp` sitting next to the running executable. The shim
//     and this installer ship in the same release archive, so a user
//     who unpacked the archive anywhere at all gets the matching pair
//     without touching PATH.
//  3. exec.LookPath("novamem-mcp") — an installer script, package
//     manager, or `go install` put it on PATH.
//
// The returned path is absolute: host config files are read by processes
// with a different working directory than ours, so a relative command
// would resolve to nothing.
func ResolveShimBinary(explicit string) (string, error) {
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return "", fmt.Errorf("resolving novamem-mcp override %q: %w", explicit, err)
		}
		return abs, nil
	}

	name := shimBinaryName()

	if self, err := executablePath(); err == nil {
		candidate := filepath.Join(filepath.Dir(self), name)
		if isExecutableFile(candidate) {
			abs, err := filepath.Abs(candidate)
			if err == nil {
				return abs, nil
			}
		}
	}

	if found, err := exec.LookPath(name); err == nil {
		abs, err := filepath.Abs(found)
		if err == nil {
			return abs, nil
		}
	}

	return "", fmt.Errorf(
		"cannot find the %s binary: pass an explicit path (--mcp-bin / NOVAMEM_MCP_BIN), "+
			"keep it next to this executable as the release archive ships it, or put it on PATH",
		name)
}

// isExecutableFile reports whether path is a regular file with at least
// one execute bit. On Windows the mode bits carry no execute
// information, so existence as a regular file is the strongest signal
// available.
func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || !info.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

// VerifyShimBinary checks that the shim we are about to write into a
// host config can actually start.
//
// This replaces the TS verifyShim/findWorkspaceDep npm pre-flight, which
// ran `npm view … dependencies` looking for the `workspace:` protocol
// and then spawned `npx -y @azrtydxb/novamem-mcp@<v>`. That guard
// existed because of the silent v0.1.0–1.1.2 outage: every published
// shim carried `workspace:*` deps npm/npx could not resolve, so Claude
// Desktop just said "Server disconnected" with no explanation. npm is
// gone as a channel (ADR 0001), so the npm-registry half of that check
// has no meaning — but the bug class does: never write a config
// pointing at a shim that cannot start. The binary-channel equivalent
// is: the file exists, it is executable, and it runs.
//
// Its stdin is closed immediately: the shim is a stdio MCP server, so
// EOF makes it exit cleanly. Surviving to the timeout means it reached
// its read loop, which is equally healthy.
func VerifyShimBinary(path string) error {
	return verifyShimBinary(path, 10*time.Second)
}

func verifyShimBinary(path string, timeout time.Duration) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("novamem-mcp shim %q is not usable: %w", path, err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return fmt.Errorf("novamem-mcp shim %q is not a regular file", path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("novamem-mcp shim %q is not executable (mode %s)", path, info.Mode().Perm())
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, path)
	// Bogus values are fine — we only check that it starts; any tool
	// call would fail auth, which is expected in a smoke test.
	cmd.Env = append(os.Environ(),
		"NOVAMEM_BASE_URL=http://127.0.0.1:0",
		"NOVAMEM_TOKEN=smoke",
	)
	cmd.Stdin = strings.NewReader("") // immediate EOF
	cmd.Stdout = io.Discard
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	if runErr == nil {
		return nil // clean exit on EOF
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		// No crash within the timeout means the shim is parked in its
		// read loop waiting for stdin — the desired healthy state.
		return nil
	}
	detail := strings.TrimSpace(stderr.String())
	if len(detail) > 200 {
		detail = detail[:200]
	}
	if detail != "" {
		return fmt.Errorf("novamem-mcp shim %q crashed on startup: %w; stderr: %s", path, runErr, detail)
	}
	return fmt.Errorf("novamem-mcp shim %q crashed on startup: %w", path, runErr)
}

// InstallMcp installs / updates the MCP entry for a tool. It returns
// Skipped: true if the tool has no MCP adapter (skill-only host) or if
// dryRun is set.
func InstallMcp(tool ToolEntry, ctx Context, params McpInstallParams, dryRun bool) (McpInstallResult, error) {
	if tool.Mcp == nil {
		return McpInstallResult{
			ToolID:  tool.ID,
			Changed: false,
			Skipped: true,
			Reason:  "no MCP adapter for this tool",
		}, nil
	}

	configPath := filepath.Join(RootFor(tool, ctx), tool.Mcp.Path)
	rootKey := tool.Mcp.RootKeyOrDefault()
	serverKey := tool.Mcp.ServerKeyOrDefault()
	entry := BuildMcpEntry(tool.Mcp, params)

	// A missing file is not an error: it is the common case on a first
	// install, and both parsers treat empty input as an empty document.
	raw, _, err := ReadFileMaybe(configPath)
	if err != nil {
		return McpInstallResult{ToolID: tool.ID, ConfigPath: configPath}, fmt.Errorf("reading %s: %w", configPath, err)
	}

	var serialized string
	var changed bool
	if tool.Mcp.Format == "toml" {
		serialized, changed, err = mergeTomlEntry(raw, rootKey, serverKey, entry)
	} else {
		serialized, changed = mergeJSONEntry(raw, rootKey, serverKey, entry)
	}
	if err != nil {
		return McpInstallResult{ToolID: tool.ID, ConfigPath: configPath}, err
	}

	// Idempotency — if the existing entry already matches, no-op.
	if !changed {
		return McpInstallResult{ToolID: tool.ID, ConfigPath: configPath}, nil
	}

	if dryRun {
		return McpInstallResult{
			ToolID:     tool.ID,
			ConfigPath: configPath,
			Changed:    true,
			Skipped:    true,
			Reason:     "dry-run",
		}, nil
	}

	if err := WriteFileEnsureDir(configPath, serialized); err != nil {
		return McpInstallResult{ToolID: tool.ID, ConfigPath: configPath}, err
	}

	return McpInstallResult{ToolID: tool.ID, ConfigPath: configPath, Changed: true}, nil
}

// mergeJSONEntry parses raw loosely, sets rootKey.serverKey to entry,
// and renders the document. changed is false when the entry was already
// byte-identical, which is what makes a second run a no-op.
func mergeJSONEntry(raw, rootKey, serverKey string, entry *Doc) (serialized string, changed bool) {
	doc := ParseJSONLoose(raw)
	if existing, ok := doc.DeepGet([]string{rootKey, serverKey}).(*Doc); ok {
		if StringifyJSON(existing) == StringifyJSON(entry) {
			return "", false
		}
	}
	doc.DeepSet([]string{rootKey, serverKey}, entry)
	return StringifyJSON(doc), true
}

// mergeTomlEntry is the same merge for Codex's TOML config. TOML tables
// are unordered by the format's own rules and go-toml materialises them
// as Go maps, so — unlike the JSON path — key order here is the
// library's, not the user's.
func mergeTomlEntry(raw, rootKey, serverKey string, entry *Doc) (serialized string, changed bool, err error) {
	doc := parseTomlLoose(raw)
	plain := docToPlain(entry)
	if existing := tomlDeepGet(doc, []string{rootKey, serverKey}); existing != nil {
		same, cmpErr := jsonEqual(existing, plain)
		if cmpErr == nil && same {
			return "", false, nil
		}
	}
	tomlDeepSet(doc, []string{rootKey, serverKey}, plain)
	out, err := toml.Marshal(doc)
	if err != nil {
		return "", false, fmt.Errorf("serialising TOML config: %w", err)
	}
	return strings.TrimRight(string(out), "\n") + "\n", true, nil
}

// parseTomlLoose mirrors parseJsonLoose: missing, empty, or invalid
// input all yield an empty table, so the merge step always has a root to
// work against. A user with a hand-broken config gets a rewritten file
// rather than a failed install — the same trade the TS original made.
func parseTomlLoose(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	var out map[string]any
	if err := toml.Unmarshal([]byte(raw), &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func tomlDeepGet(root map[string]any, path []string) any {
	var cur any = root
	for _, seg := range path {
		table, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		v, present := table[seg]
		if !present {
			return nil
		}
		cur = v
	}
	return cur
}

func tomlDeepSet(root map[string]any, path []string, value any) {
	if len(path) == 0 {
		return
	}
	cur := root
	for _, seg := range path[:len(path)-1] {
		next, ok := cur[seg].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[seg] = next
		}
		cur = next
	}
	cur[path[len(path)-1]] = value
}

// docToPlain flattens an ordered *Doc into the plain maps/slices
// go-toml can marshal. Order is lost here by necessity; see
// mergeTomlEntry.
func docToPlain(v any) any {
	switch val := v.(type) {
	case *Doc:
		out := make(map[string]any, val.Len())
		for _, k := range val.Keys() {
			child, _ := val.Get(k)
			out[k] = docToPlain(child)
		}
		return out
	case []any:
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = docToPlain(item)
		}
		return out
	default:
		return v
	}
}

// jsonEqual compares two plain values structurally. encoding/json sorts
// map keys, which makes it a stable canonical form for an equality test
// (it is never used to render a file — StringifyJSON does that).
func jsonEqual(a, b any) (bool, error) {
	ab, err := json.Marshal(a)
	if err != nil {
		return false, err
	}
	bb, err := json.Marshal(b)
	if err != nil {
		return false, err
	}
	return bytes.Equal(ab, bb), nil
}
