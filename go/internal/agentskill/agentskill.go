// Package agentskill owns the agent-facing behavioural contract.
//
// There is exactly one copy of that contract in the tree: skill/SKILL.md.
// The installer ships it to clients that read skills from disk, and the
// MCP server sends the marked part of the same file as the
// `instructions` field on `initialize` for clients that honour it.
//
// It used to exist twice — a markdown skill and a hand-maintained Go
// string constant — which agreed only for as long as someone kept them
// aligned. Deriving one from the other removes the possibility of drift
// rather than testing for it after the fact.
package agentskill

import (
	"embed"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
)

//go:embed all:skill
var skillFS embed.FS

// The region markers. Everything between a start and the next end is
// part of the wire instructions; everything else is skill-only (the
// front matter, the note explaining the skill/instructions split, and
// the deeper reference material a disk-installed skill can link to).
const (
	markerStart = "<!-- mcp-instructions:start -->"
	markerEnd   = "<!-- mcp-instructions:end -->"
)

// mdLink matches any markdown link; flattenRelativeLinks decides which
// targets survive. Repo-relative paths mean nothing to a client that
// received this text over the wire and has no skill directory, so their
// target is dropped and the link text kept. Absolute URLs and in-page
// anchors resolve anywhere, so they are left alone.
var mdLink = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)

func flattenRelativeLinks(s string) string {
	return mdLink.ReplaceAllStringFunc(s, func(m string) string {
		g := mdLink.FindStringSubmatch(m)
		target := strings.TrimSpace(g[2])
		if strings.Contains(target, "://") ||
			strings.HasPrefix(target, "#") ||
			strings.HasPrefix(target, "mailto:") {
			return m
		}
		return g[1]
	})
}

// FS returns the skill tree rooted where an installer expects it.
func FS() (fs.FS, error) { return fs.Sub(skillFS, "skill") }

// Markdown returns SKILL.md verbatim.
func Markdown() ([]byte, error) { return fs.ReadFile(skillFS, "skill/SKILL.md") }

// Instructions renders the MCP `instructions` payload from the marked
// regions of SKILL.md, in document order.
func Instructions() (string, error) {
	md, err := Markdown()
	if err != nil {
		return "", err
	}
	out, err := extractMarked(string(md))
	if err != nil {
		return "", err
	}
	return out, nil
}

// extractMarked pulls the marked regions out of a document. An
// unbalanced or out-of-order marker is an error rather than a silent
// truncation: this text is a contract, and shipping half of it because
// an editor dropped a line is worse than failing loudly at startup.
func extractMarked(doc string) (string, error) {
	var regions []string
	rest := doc
	for {
		i := strings.Index(rest, markerStart)
		if i < 0 {
			break
		}
		// An end marker in the text we are about to skip has no start —
		// silently dropping it would render a truncated contract.
		if strings.Contains(rest[:i], markerEnd) {
			return "", fmt.Errorf("agentskill: %q with no matching %q", markerEnd, markerStart)
		}
		after := rest[i+len(markerStart):]
		j := strings.Index(after, markerEnd)
		if j < 0 {
			return "", fmt.Errorf("agentskill: %q with no matching %q", markerStart, markerEnd)
		}
		if k := strings.Index(after[:j], markerStart); k >= 0 {
			return "", fmt.Errorf("agentskill: nested %q", markerStart)
		}
		regions = append(regions, strings.TrimSpace(after[:j]))
		rest = after[j+len(markerEnd):]
	}
	if strings.Contains(rest, markerEnd) {
		return "", fmt.Errorf("agentskill: %q with no matching %q", markerEnd, markerStart)
	}
	if len(regions) == 0 {
		return "", fmt.Errorf("agentskill: SKILL.md contains no %q region", markerStart)
	}
	joined := strings.Join(regions, "\n\n")
	joined = flattenRelativeLinks(joined)
	return joined + "\n", nil
}
