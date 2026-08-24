// Package initcli is the novamem installer: it detects which AI-agent
// hosts are present, then writes each one an MCP server entry, a skill
// bundle, and slash commands. Ported from packages/init (TypeScript).
//
// The registry in tools.go is the only place a host is described; every
// installer here reads from it, so adding a host is one row rather than
// a new code path.
//
// One deliberate behavioural change from the TypeScript original, per
// ADR 0001 (Go tools ship as release binaries, npm is not a channel):
// stdio MCP entries invoke the shipped novamem-mcp BINARY instead of
// `npx @azrtydxb/novamem-mcp@<version>`. Everything else the installer
// writes is byte-identical, pinned by testdata/golden.json — fixtures
// generated from the TypeScript implementation before it was retired.
package initcli

// Scope says whether a host keeps its config beside the project or in
// the user's home directory.
type Scope string

const (
	ScopeProject Scope = "project"
	ScopeUser    Scope = "user"
)

// McpAdapter describes the on-disk shape a host expects for its MCP
// server map.
type McpAdapter struct {
	// Path is the config file, relative to the scope root (the project
	// root for ScopeProject, $HOME for ScopeUser).
	Path   string
	Format string // "json" | "toml"
	// RootKey is the top-level key holding the server map. Default
	// "mcpServers".
	RootKey string
	// ServerKey is our entry's key in that map. Default "novamem".
	ServerKey string
	// Transport our entry advertises. Default "sse".
	Transport string // "sse" | "stdio"
	// StdioEnvKey is the field name a host expects for stdio env maps.
	// Default "env"; OpenCode uses "environment".
	StdioEnvKey string
	// StdioTypeField, when set, injects {"type": <value>} into a stdio
	// entry — OpenCode needs type:"local"; Claude Desktop and Codex
	// parse fine without it.
	StdioTypeField string
}

// CommandAdapter describes where a host keeps slash commands and in
// which flavour it wants them rendered.
type CommandAdapter struct {
	// Dir is the command directory, relative to the scope root.
	Dir string
	// Format is the rendered flavour: "claude-md", "continue-prompt",
	// "github-prompt-md", or "gemini-toml".
	Format string
	// Prefix namespaces our filenames in a shared directory (e.g.
	// "memory-").
	Prefix string
}

// ToolEntry is one host in the registry.
type ToolEntry struct {
	ID    string
	Name  string
	Scope Scope
	// SkillsBase is where the bundle lands, relative to the scope root:
	// the final path is <SkillsBase>/skills/novamem/.
	SkillsBase string
	// Detect paths, relative to the scope root. Any hit means installed.
	Detect []string
	// Mcp is nil for hosts whose MCP format we do not know.
	Mcp *McpAdapter
	// Commands is nil for hosts that do not consume slash commands.
	Commands *CommandAdapter
	// PostInstallHint is one line printed in the install summary.
	PostInstallHint string
}

// RootKeyOrDefault, ServerKeyOrDefault, TransportOrDefault and
// StdioEnvKeyOrDefault apply the registry's documented defaults, so the
// table stays sparse and no installer re-derives them.
func (a *McpAdapter) RootKeyOrDefault() string {
	if a.RootKey != "" {
		return a.RootKey
	}
	return "mcpServers"
}

func (a *McpAdapter) ServerKeyOrDefault() string {
	if a.ServerKey != "" {
		return a.ServerKey
	}
	return "novamem"
}

func (a *McpAdapter) TransportOrDefault() string {
	if a.Transport != "" {
		return a.Transport
	}
	return "sse"
}

func (a *McpAdapter) StdioEnvKeyOrDefault() string {
	if a.StdioEnvKey != "" {
		return a.StdioEnvKey
	}
	return "env"
}

// Context is where the installer looks for each scope.
type Context struct {
	ProjectRoot string
	Home        string
}

// RootFor returns the absolute base path a tool's paths resolve against.
func RootFor(tool ToolEntry, ctx Context) string {
	if tool.Scope == ScopeUser {
		return ctx.Home
	}
	return ctx.ProjectRoot
}
