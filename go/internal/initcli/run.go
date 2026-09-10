package initcli

// Run orchestrator — given a chosen list of tools and the resolved
// params, apply skill + MCP + commands to each, collecting per-tool
// results. Pure I/O, no prompts: the CLI layer wraps this with the
// terminal interaction and the pretty output.

// RunParams is everything applying a tool needs.
type RunParams struct {
	BaseURL string
	Bearer  string
	Ctx     Context
	DryRun  bool
	// ShimBinary is the novamem-mcp path written into stdio entries
	// (ADR 0001 — there is no npm spec to pin any more).
	ShimBinary string
	// SkillDir and CommandsDir are the materialised asset trees; the
	// TypeScript installer derived these from its bundled dist/assets.
	SkillDir    string
	CommandsDir string
}

// ToolResult is what happened to one host.
type ToolResult struct {
	Tool     ToolEntry
	Skill    SkillInstallResult
	Mcp      McpInstallResult
	Commands CommandInstallResult
	// Err is the first failure for this tool, if any. One host's broken
	// config must not abort the others — the TypeScript version let an
	// exception unwind the whole run, which left earlier hosts written
	// and later ones untouched with no summary explaining why.
	Err error
}

// ApplyTools installs into each tool in turn, always returning one
// result per tool.
func ApplyTools(tools []ToolEntry, params RunParams) []ToolResult {
	results := make([]ToolResult, 0, len(tools))
	for _, tool := range tools {
		res := ToolResult{Tool: tool}

		skill, err := InstallSkill(tool, params.Ctx, SkillInstallOptions{
			DryRun:    params.DryRun,
			SourceDir: params.SkillDir,
		})
		res.Skill = skill
		if err != nil {
			res.Err = err
		}

		mcp, err := InstallMcp(tool, params.Ctx, McpInstallParams{
			BaseURL:    params.BaseURL,
			Bearer:     params.Bearer,
			ShimBinary: params.ShimBinary,
		}, params.DryRun)
		res.Mcp = mcp
		if err != nil && res.Err == nil {
			res.Err = err
		}

		cmds, err := InstallCommands(tool, params.Ctx, CommandInstallOptions{
			DryRun:    params.DryRun,
			SourceDir: params.CommandsDir,
		})
		res.Commands = cmds
		if err != nil && res.Err == nil {
			res.Err = err
		}

		results = append(results, res)
	}
	return results
}
