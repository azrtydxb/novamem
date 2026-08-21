package initcli

// Registry of every AI-agent host we know how to configure.
//
// Inspired by OpenSpec's `AI_TOOLS` table. Each entry declares:
//   - where its config lives (project-local vs user-global)
//   - where to drop the skill bundle (every tool gets this)
//   - optional MCP adapter — the JSON/TOML shape the host expects
//   - optional slash-command adapter — file format + path convention
//
// Adding a new tool is one row. Adding skill-only support is one row
// with no Mcp and no Commands. The installer code reads from this
// registry only — no per-tool source files.
//
// Rows stay sparse on purpose: leave a field zero and the *OrDefault
// accessors in types.go supply the documented default.
//
// 30 tools in OpenSpec's inventory + Claude Desktop (which OpenSpec
// doesn't configure since it's a desktop app rather than a coding
// agent). Skill support is uniform; MCP and commands are filled in for
// the hosts whose formats we've verified.
var Tools = []ToolEntry{
	// ─── Coding agents with full Claude-Code-style support ───────────────
	{
		ID:         "claude-code",
		Name:       "Claude Code",
		Scope:      ScopeProject,
		SkillsBase: ".claude",
		Detect:     []string{".claude", ".mcp.json"},
		Mcp:        &McpAdapter{Path: ".mcp.json", Format: "json", Transport: "sse"},
		Commands:   &CommandAdapter{Dir: ".claude/commands", Format: "claude-md"},
		PostInstallHint: "Restart Claude Code to pick up the new MCP server and skill.",
	},
	{
		ID:         "claude-desktop",
		Name:       "Claude Desktop",
		Scope:      ScopeUser,
		SkillsBase: ".claude",
		Detect: []string{
			"Library/Application Support/Claude/claude_desktop_config.json",
			"AppData/Roaming/Claude/claude_desktop_config.json",
		},
		Mcp: &McpAdapter{
			// macOS path — Linux/Windows users get a config-write warning but the
			// installer still works if the dir exists.
			Path:   "Library/Application Support/Claude/claude_desktop_config.json",
			Format: "json",
			// Claude Desktop's MCP loader only accepts stdio entries
			// (`command`/`args`). Writing {type: "sse", url, headers} makes
			// it pop up "not valid MCP server configurations and were
			// skipped". Use the stdio shim — it bridges to /mcp/sse on the
			// server with the bearer in env.
			Transport: "stdio",
		},
		PostInstallHint: "Quit Claude Desktop fully (Cmd-Q on macOS) and reopen — it doesn't hot-reload MCP config.",
	},
	{
		ID:              "cursor",
		Name:            "Cursor",
		Scope:           ScopeProject,
		SkillsBase:      ".cursor",
		Detect:          []string{".cursor", ".cursor/mcp.json"},
		Mcp:             &McpAdapter{Path: ".cursor/mcp.json", Format: "json", Transport: "sse"},
		Commands:        &CommandAdapter{Dir: ".cursor/commands", Format: "claude-md"},
		PostInstallHint: "Open Cursor → Settings → MCP and toggle 'novamem' on if it isn't already.",
	},
	{
		ID:         "kilocode",
		Name:       "Kilo Code",
		Scope:      ScopeProject,
		SkillsBase: ".kilocode",
		Detect:     []string{".kilocode"},
		Mcp:        &McpAdapter{Path: ".kilocode/mcp.json", Format: "json", Transport: "sse"},
		Commands:   &CommandAdapter{Dir: ".kilocode/workflows", Format: "claude-md"},
	},
	{
		ID:         "opencode",
		Name:       "OpenCode",
		Scope:      ScopeProject,
		SkillsBase: ".opencode",
		Detect:     []string{".opencode"},
		// OpenCode's remote-MCP path is broken for SSE servers (sst/opencode
		// #834: "Server error: UnknownError" on every SSE handshake) and
		// Streamable HTTP isn't shipped yet (#8058). Plus their config schema
		// uses `mcp` (not `mcpServers`) as the top-level key, with stdio
		// entries shaped {type: "local", command, args, environment} —
		// not `env`. Route through the stdio shim until either lands.
		Mcp: &McpAdapter{
			Path:           ".opencode/opencode.json",
			Format:         "json",
			RootKey:        "mcp",
			Transport:      "stdio",
			StdioTypeField: "local",
			StdioEnvKey:    "environment",
		},
		Commands: &CommandAdapter{Dir: ".opencode/commands", Format: "claude-md"},
	},
	{
		ID:         "roocode",
		Name:       "RooCode",
		Scope:      ScopeProject,
		SkillsBase: ".roo",
		Detect:     []string{".roo"},
		Commands:   &CommandAdapter{Dir: ".roo/commands", Format: "claude-md"},
	},
	{
		ID:         "cline",
		Name:       "Cline",
		Scope:      ScopeProject,
		SkillsBase: ".cline",
		Detect:     []string{".cline", ".clinerules"},
		Commands:   &CommandAdapter{Dir: ".clinerules/workflows", Format: "claude-md"},
	},
	{
		ID:         "continue",
		Name:       "Continue",
		Scope:      ScopeProject,
		SkillsBase: ".continue",
		Detect:     []string{".continue"},
		Commands:   &CommandAdapter{Dir: ".continue/prompts", Format: "continue-prompt"},
	},
	{
		ID:         "github-copilot",
		Name:       "GitHub Copilot",
		Scope:      ScopeProject,
		SkillsBase: ".github",
		Detect: []string{
			".github/copilot-instructions.md",
			".github/instructions",
			".github/prompts",
			".github/skills",
			".mcp.json",
		},
		Mcp:      &McpAdapter{Path: ".mcp.json", Format: "json", Transport: "sse"},
		Commands: &CommandAdapter{Dir: ".github/prompts", Format: "github-prompt-md"},
	},
	{
		ID:         "gemini",
		Name:       "Gemini CLI",
		Scope:      ScopeUser,
		SkillsBase: ".gemini",
		Detect:     []string{".gemini"},
		// Gemini CLI's `url`-keyed remote SSE entry historically dropped
		// configured `headers` (google-gemini/gemini-cli#2427); the fix
		// (#13762) shipped, but older installs still in the wild silently
		// strip our `Authorization: Bearer …` and the server 401s.
		// Route through the stdio shim — env vars are guaranteed-forwarded
		// and the protocol is the same regardless of CLI version.
		Mcp: &McpAdapter{
			Path:      ".gemini/settings.json",
			Format:    "json",
			Transport: "stdio",
		},
		Commands: &CommandAdapter{Dir: ".gemini/commands", Format: "gemini-toml"},
	},
	{
		ID:         "codex",
		Name:       "OpenAI Codex CLI",
		Scope:      ScopeUser,
		SkillsBase: ".codex",
		Detect:     []string{".codex"},
		Mcp: &McpAdapter{
			Path:    ".codex/config.toml",
			Format:  "toml",
			RootKey: "mcp_servers",
			// Codex CLI's MCP client speaks Streamable-HTTP, not the legacy
			// SSE transport novamem currently exposes at /mcp/sse. Pointing
			// it at the SSE URL produces a cryptic handshake failure:
			//   "Deserialize error: data did not match any variant of
			//    untagged enum JsonRpcMessage"
			// Use the stdio shim — it bridges to /mcp/sse internally and is
			// protocol-agnostic to the host.
			Transport: "stdio",
		},
		Commands: &CommandAdapter{Dir: ".codex/prompts", Format: "claude-md", Prefix: "memory-"},
	},
	{
		ID:         "factory",
		Name:       "Factory Droid",
		Scope:      ScopeProject,
		SkillsBase: ".factory",
		Detect:     []string{".factory"},
		Commands:   &CommandAdapter{Dir: ".factory/commands", Format: "claude-md"},
	},
	{
		ID:         "windsurf",
		Name:       "Windsurf",
		Scope:      ScopeProject,
		SkillsBase: ".windsurf",
		Detect:     []string{".windsurf"},
		Commands:   &CommandAdapter{Dir: ".windsurf/workflows", Format: "claude-md"},
	},
	{
		ID:         "amazon-q",
		Name:       "Amazon Q Developer",
		Scope:      ScopeProject,
		SkillsBase: ".amazonq",
		Detect:     []string{".amazonq"},
		Commands: &CommandAdapter{
			Dir:    ".amazonq/prompts",
			Format: "claude-md",
			Prefix: "memory-",
		},
	},

	// ─── Skill-only hosts (all 30 from OpenSpec's inventory) ─────────────
	// These hosts read skills from <skillsBase>/skills/<name>/. We don't
	// (yet) have verified MCP or slash-command formats for them, so they
	// just get the skill bundle. They can still call the MCP server if the
	// user wires it manually, or via one of the other hosts already doing so.
	{
		ID:         "antigravity",
		Name:       "Antigravity",
		Scope:      ScopeProject,
		SkillsBase: ".agent",
		Detect:     []string{".agent"},
	},
	{
		ID:         "auggie",
		Name:       "Auggie / Augment CLI",
		Scope:      ScopeProject,
		SkillsBase: ".augment",
		Detect:     []string{".augment"},
	},
	{
		ID:         "bob",
		Name:       "Bob Shell",
		Scope:      ScopeProject,
		SkillsBase: ".bob",
		Detect:     []string{".bob"},
	},
	{
		ID:         "codebuddy",
		Name:       "CodeBuddy Code",
		Scope:      ScopeProject,
		SkillsBase: ".codebuddy",
		Detect:     []string{".codebuddy"},
	},
	{
		ID:         "costrict",
		Name:       "CoStrict",
		Scope:      ScopeProject,
		SkillsBase: ".cospec",
		Detect:     []string{".cospec"},
	},
	{
		ID:         "crush",
		Name:       "Crush",
		Scope:      ScopeProject,
		SkillsBase: ".crush",
		Detect:     []string{".crush"},
	},
	{
		ID:         "forgecode",
		Name:       "ForgeCode",
		Scope:      ScopeProject,
		SkillsBase: ".forge",
		Detect:     []string{".forge"},
	},
	{
		ID:         "iflow",
		Name:       "iFlow",
		Scope:      ScopeProject,
		SkillsBase: ".iflow",
		Detect:     []string{".iflow"},
	},
	{
		ID:         "junie",
		Name:       "Junie",
		Scope:      ScopeProject,
		SkillsBase: ".junie",
		Detect:     []string{".junie"},
	},
	{
		ID:         "kimi",
		Name:       "Kimi CLI",
		Scope:      ScopeProject,
		SkillsBase: ".kimi",
		Detect:     []string{".kimi"},
	},
	{
		ID:         "kiro",
		Name:       "Kiro",
		Scope:      ScopeProject,
		SkillsBase: ".kiro",
		Detect:     []string{".kiro"},
	},
	{
		ID:         "lingma",
		Name:       "Lingma",
		Scope:      ScopeProject,
		SkillsBase: ".lingma",
		Detect:     []string{".lingma"},
	},
	{
		ID:         "pi",
		Name:       "Pi",
		Scope:      ScopeProject,
		SkillsBase: ".pi",
		Detect:     []string{".pi"},
	},
	{
		ID:         "qoder",
		Name:       "Qoder",
		Scope:      ScopeProject,
		SkillsBase: ".qoder",
		Detect:     []string{".qoder"},
	},
	{
		ID:         "qwen",
		Name:       "Qwen Code",
		Scope:      ScopeProject,
		SkillsBase: ".qwen",
		Detect:     []string{".qwen"},
	},
	{
		ID:         "trae",
		Name:       "Trae",
		Scope:      ScopeProject,
		SkillsBase: ".trae",
		Detect:     []string{".trae"},
	},
}

// FindTool returns the registry row with the given id, or nil when no
// host matches. Mirrors findTool() in packages/init/src/tools.ts.
func FindTool(id string) *ToolEntry {
	for i := range Tools {
		if Tools[i].ID == id {
			return &Tools[i]
		}
	}
	return nil
}
