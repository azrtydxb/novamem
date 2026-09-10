package initcli

// Slash-command installer — copies the command files (the repo's
// integrations/claude-code/commands/) into each host's commands
// directory, reformatted per the host's expected file shape.
//
// Source format: YAML frontmatter + markdown body, the Claude Code
// shape. Per-host adapters re-emit either the same shape (most hosts), a
// `.prompt` flat file (Continue), a `.prompt.md` file (GitHub Copilot),
// or a TOML file (Gemini CLI).
//
// Deliberate difference from the TypeScript original: there is no
// bundledCommandsPath(). The TS package copied the commands into
// dist/assets/ at build time and resolved them relative to the running
// module; the Go binary has no such asset dir, so the caller passes the
// source directory explicitly (CommandInstallOptions.SourceDir).

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// CommandInstallResult reports what one tool's command install did.
type CommandInstallResult struct {
	ToolID string
	// FilesWritten are the files we wrote / would write.
	FilesWritten []string
	Skipped      bool
	Reason       string
}

// CommandInstallOptions tunes InstallCommands.
type CommandInstallOptions struct {
	DryRun bool
	// SourceDir holds the *.md command sources. Required — see the
	// package note above about the missing bundledCommandsPath().
	SourceDir string
}

// CommandField is one frontmatter key/value pair. Frontmatter is held as
// an ordered slice, not a map: renderCommand re-emits the fields in
// source order and the golden fixtures pin that order.
type CommandField struct {
	Key   string
	Value string
}

// ParsedCommand is a command file split into frontmatter and body.
type ParsedCommand struct {
	// Frontmatter is the parsed YAML between the leading `---` lines.
	Frontmatter []CommandField
	// Body is the markdown after the second `---`.
	Body string
}

// FrontmatterValue returns the value for key, or "" when absent.
func (p ParsedCommand) FrontmatterValue(key string) string {
	for _, f := range p.Frontmatter {
		if f.Key == key {
			return f.Value
		}
	}
	return ""
}

// setField mirrors the TypeScript `fm[key] = value` on a plain object:
// a repeated key overwrites in place and keeps its original position.
func (p *ParsedCommand) setField(key, value string) {
	for i := range p.Frontmatter {
		if p.Frontmatter[i].Key == key {
			p.Frontmatter[i].Value = value
			return
		}
	}
	p.Frontmatter = append(p.Frontmatter, CommandField{Key: key, Value: value})
}

// frontmatterLine mirrors the TS /^([a-z][\w-]*):\s*(.*)$/i — a key that
// starts with a letter, then word characters or dashes.
var frontmatterLine = regexp.MustCompile(`(?i)^([a-z][\w-]*):[\t ]*(.*)$`)

// splitLines mirrors JavaScript's raw.split(/\r?\n/).
func splitLines(raw string) []string {
	return strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
}

// ParseCommandFile parses a Claude-Code-style command file: YAML
// frontmatter + body. A file without a well-formed frontmatter block is
// returned whole as the body, exactly as the TS version does.
func ParseCommandFile(raw string) ParsedCommand {
	lines := splitLines(raw)
	if len(lines) == 0 || lines[0] != "---" {
		return ParsedCommand{Body: raw}
	}
	closeIdx := -1
	for i := 1; i < len(lines); i++ {
		if lines[i] == "---" {
			closeIdx = i
			break
		}
	}
	if closeIdx == -1 {
		return ParsedCommand{Body: raw}
	}
	var parsed ParsedCommand
	for _, line := range lines[1:closeIdx] {
		if m := frontmatterLine.FindStringSubmatch(line); m != nil {
			parsed.setField(m[1], strings.TrimSpace(m[2]))
		}
	}
	body := strings.Join(lines[closeIdx+1:], "\n")
	// .replace(/^\n/, "") — strip exactly ONE leading newline, the blank
	// line conventionally left after the closing `---`.
	body = strings.TrimPrefix(body, "\n")
	parsed.Body = body
	return parsed
}

// RenderCommand renders the parsed command in the target host's expected
// file format. An unknown format is a programming error in the registry,
// so it is reported as an error rather than silently emitting nothing
// (the TS switch fell through to `undefined`).
func RenderCommand(cmd ParsedCommand, format string) (string, error) {
	switch format {
	case "claude-md", "github-prompt-md":
		// Same source format works as-is for Claude/Cursor/Kilo/OpenCode/
		// RooCode/Cline/Factory/Windsurf/Amazon-Q/Codex. GitHub Copilot's
		// .prompt.md uses the identical YAML-frontmatter + markdown shape.
		var fm strings.Builder
		for _, f := range cmd.Frontmatter {
			fm.WriteString(f.Key)
			fm.WriteString(": ")
			fm.WriteString(f.Value)
			fm.WriteString("\n")
		}
		return "---\n" + fm.String() + "---\n\n" + cmd.Body, nil
	case "continue-prompt":
		// Continue's `.prompt` files are plain markdown — no frontmatter.
		// Stash the description as the first paragraph so the user can see
		// what each prompt does.
		desc := cmd.FrontmatterValue("description")
		if desc != "" {
			return desc + "\n\n" + cmd.Body, nil
		}
		return cmd.Body, nil
	case "gemini-toml":
		// Gemini CLI's commands are TOML files with a known schema. We map:
		//   description     → description
		//   argument-hint   → arguments[0].hint  (placeholder shape)
		//   body            → prompt
		//
		// Emitted by hand rather than through a TOML library: the document
		// is two string keys whose ORDER is pinned by the fixtures (prompt
		// first, description second — JS object insertion order), and the
		// TS side used smol-toml, whose string formatter is
		// `JSON.stringify(s).replace(/\x7f/g, "\\u007f")`. tomlBasicString
		// reproduces exactly that.
		var b strings.Builder
		b.WriteString("prompt = ")
		b.WriteString(tomlBasicString(strings.TrimSpace(cmd.Body)))
		b.WriteString("\n")
		if desc := cmd.FrontmatterValue("description"); desc != "" {
			b.WriteString("description = ")
			b.WriteString(tomlBasicString(desc))
			b.WriteString("\n")
		}
		// stringifyToml() appended a trailing newline to smol-toml's
		// already newline-terminated output, so the files end "\n\n".
		b.WriteString("\n")
		return b.String(), nil
	default:
		return "", fmt.Errorf("unknown command format %q", format)
	}
}

const hexDigits = "0123456789abcdef"

// tomlBasicString quotes s the way smol-toml does: JSON.stringify plus
// U+007F escaped. That means a single-line basic string with \n, \t, \r,
// \b, \f, \", \\ escapes, other C0 controls as \u00xx, and every
// non-ASCII rune passed through literally (the fixtures contain em
// dashes and curly quotes verbatim).
func tomlBasicString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case 0x7f:
			b.WriteString(`\u007f`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[(r>>4)&0xf])
				b.WriteByte(hexDigits[r&0xf])
				continue
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// DestFilename determines the destination filename for a single command.
// The adapter prefix namespaces our files in directories a host shares
// with the user's own commands (Codex's .codex/prompts, for instance,
// takes "memory-"), and is applied to the base name BEFORE the format's
// extension is appended.
func DestFilename(srcName string, adapter CommandAdapter) (string, error) {
	base := strings.TrimSuffix(filepath.Base(srcName), ".md")
	prefixed := base
	if adapter.Prefix != "" {
		prefixed = adapter.Prefix + base
	}
	switch adapter.Format {
	case "claude-md":
		return prefixed + ".md", nil
	case "continue-prompt":
		return prefixed + ".prompt", nil
	case "github-prompt-md":
		return prefixed + ".prompt.md", nil
	case "gemini-toml":
		return prefixed + ".toml", nil
	default:
		return "", fmt.Errorf("unknown command format %q", adapter.Format)
	}
}

// InstallCommands installs slash commands for one tool. It no-ops for
// tools without a command adapter.
func InstallCommands(tool ToolEntry, ctx Context, opts CommandInstallOptions) (CommandInstallResult, error) {
	if tool.Commands == nil {
		return CommandInstallResult{
			ToolID:       tool.ID,
			FilesWritten: []string{},
			Skipped:      true,
			Reason:       "no command adapter for this tool",
		}, nil
	}
	if opts.SourceDir == "" {
		return CommandInstallResult{}, fmt.Errorf("command source directory not set for %s", tool.ID)
	}
	adapter := *tool.Commands
	destDir := filepath.Join(RootFor(tool, ctx), adapter.Dir)

	entries, err := os.ReadDir(opts.SourceDir)
	if err != nil {
		return CommandInstallResult{}, fmt.Errorf("read command sources %s: %w", opts.SourceDir, err)
	}
	var sourceFiles []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			sourceFiles = append(sourceFiles, e.Name())
		}
	}
	if len(sourceFiles) == 0 {
		return CommandInstallResult{
			ToolID:       tool.ID,
			FilesWritten: []string{},
			Skipped:      true,
			Reason:       fmt.Sprintf("no source command files at %s", opts.SourceDir),
		}, nil
	}

	if !opts.DryRun {
		if err := os.MkdirAll(destDir, 0o755); err != nil {
			return CommandInstallResult{}, fmt.Errorf("create %s: %w", destDir, err)
		}
	}

	writtenPaths := make([]string, 0, len(sourceFiles))
	for _, srcName := range sourceFiles {
		srcPath := filepath.Join(opts.SourceDir, srcName)
		raw, err := os.ReadFile(srcPath)
		if err != nil {
			return CommandInstallResult{}, fmt.Errorf("read %s: %w", srcPath, err)
		}
		parsed := ParseCommandFile(string(raw))
		out, err := RenderCommand(parsed, adapter.Format)
		if err != nil {
			return CommandInstallResult{}, fmt.Errorf("render %s for %s: %w", srcName, tool.ID, err)
		}
		name, err := DestFilename(srcName, adapter)
		if err != nil {
			return CommandInstallResult{}, fmt.Errorf("name %s for %s: %w", srcName, tool.ID, err)
		}
		destPath := filepath.Join(destDir, name)
		if !opts.DryRun {
			if err := os.WriteFile(destPath, []byte(out), 0o644); err != nil {
				return CommandInstallResult{}, fmt.Errorf("write %s: %w", destPath, err)
			}
		}
		writtenPaths = append(writtenPaths, destPath)
	}

	res := CommandInstallResult{
		ToolID:       tool.ID,
		FilesWritten: writtenPaths,
		Skipped:      opts.DryRun,
	}
	if opts.DryRun {
		res.Reason = "dry-run"
	}
	return res, nil
}
