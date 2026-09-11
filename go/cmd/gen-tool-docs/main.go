// gen-tool-docs renders the MCP tool catalogue in
// docs/api/mcp-tools.md from the tool surface.
//
// That surface is itself generated: api/openapi.yaml is the contract, and
// cmd/gen-contract writes tooldefs.json from the `x-mcp-tool` extension
// on each operation. So this page is two steps from the one source, and
// no step is hand-copied.
//
// The page used to carry a hand-written table: one paraphrase per tool,
// of a description that already existed canonically.
// Two copies of the same fact, kept in step by diligence, which is how a
// page ends up promising a tool that was removed or omitting one that
// was added — the same shape as the /api-docs route that 404'd for
// months while three documents advertised it.
//
// The package that owns the agent contract put it best: deriving one
// from the other removes the possibility of drift rather than testing
// for it after the fact. This does that for the tool catalogue.
//
// Only the region between the markers is generated. Everything else on
// the page — transports, conventions, the prose that explains when to
// reach for MCP at all — is genuinely explanatory and stays hand-written.
//
// Run it, then commit the result; CI regenerates and fails on a dirty
// tree, exactly as it does for docs/api/openapi.json.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/mcp"
)

const (
	markerStart = "<!-- tool-catalogue:start -->"
	markerEnd   = "<!-- tool-catalogue:end -->"
	docPath     = "../docs/api/mcp-tools.md"
)

type tool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	InputSchema struct {
		Properties map[string]struct {
			Type        string `json:"type"`
			Description string `json:"description"`
		} `json:"properties"`
		Required []string `json:"required"`
	} `json:"inputSchema"`
}

func main() {
	var tools []tool
	if err := json.Unmarshal(mcp.ToolDefinitions(), &tools); err != nil {
		fail("decoding the tool definitions: %v", err)
	}

	page, err := os.ReadFile(docPath)
	if err != nil {
		fail("reading %s: %v", docPath, err)
	}
	start := strings.Index(string(page), markerStart)
	end := strings.Index(string(page), markerEnd)
	if start < 0 || end < 0 || end < start {
		fail("%s has no %s … %s region to fill", docPath, markerStart, markerEnd)
	}

	out := string(page[:start+len(markerStart)]) + "\n\n" +
		render(tools) + "\n" + string(page[end:])
	if err := os.WriteFile(docPath, []byte(out), 0o644); err != nil {
		fail("writing %s: %v", docPath, err)
	}
	fmt.Printf("wrote %s (%d tools)\n", docPath, len(tools))
}

// render writes one section per family, each tool with the description
// the server actually advertises and its arguments.
func render(tools []tool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "_%d tools. This section is generated from "+
		"[`go/internal/mcp/tooldefs.json`](https://github.com/azrtydxb/novamem/blob/main/go/internal/mcp/tooldefs.json) "+
		"by `go run ./cmd/gen-tool-docs` — the descriptions below are the ones the server sends on `tools/list`, "+
		"not a paraphrase of them. Edit [`api/openapi.yaml`](https://github.com/azrtydxb/novamem/blob/main/api/openapi.yaml) "+
		"and re-run `go run ./cmd/gen-contract && go run ./cmd/gen-tool-docs` — not this table, and not tooldefs.json, "+
		"which is itself generated._\n", len(tools))

	rendered := map[string]bool{}
	for _, family := range []struct{ prefix, heading string }{
		{"memory_", "Memory tools"},
		{"project_", "Project tools"},
	} {
		fmt.Fprintf(&b, "\n## %s\n\n", family.heading)
		for _, t := range tools {
			if !strings.HasPrefix(t.Name, family.prefix) {
				continue
			}
			rendered[t.Name] = true
			fmt.Fprintf(&b, "### `%s`\n\n%s\n\n", t.Name, prose(t.Description))
			b.WriteString(args(t))
			b.WriteString("\n")
		}
	}
	// Section joins can stack blank lines; prettier allows at most one,
	// and a page that the formatter rewrites turns the CI drift gate into
	// a permanent false positive.
	out := blankRun.ReplaceAllString(b.String(), "\n\n")
	// A tool outside the known families would otherwise be counted in the
	// header and then silently left out of the page — a catalogue that
	// says 22 and lists 21. Louder to stop than to under-report.
	for _, t := range tools {
		if !rendered[t.Name] {
			fail("tool %q is in no rendered family — add a section for its prefix", t.Name)
		}
	}
	return strings.TrimRight(out, "\n") + "\n"
}

// blankRun matches three or more consecutive newlines.
var blankRun = regexp.MustCompile(`\n{3,}`)

func args(t tool) string {
	if len(t.InputSchema.Properties) == 0 {
		return "Takes no arguments.\n"
	}
	required := map[string]bool{}
	for _, r := range t.InputSchema.Required {
		required[r] = true
	}
	names := make([]string, 0, len(t.InputSchema.Properties))
	for n := range t.InputSchema.Properties {
		names = append(names, n)
	}
	sort.Strings(names)

	rows := [][4]string{{"Argument", "Type", "Required", "Description"}}
	for _, n := range names {
		p := t.InputSchema.Properties[n]
		req := ""
		if required[n] {
			req = "yes"
		}
		desc := p.Description
		if desc == "" {
			// Visible rather than blank: an undocumented argument is a
			// thing an agent has to guess at, and #266 tracks filling
			// these in. Generating the page turns that from an invisible
			// omission into something a reader can see and count.
			desc = "_undocumented — see #266_"
		}
		rows = append(rows, [4]string{"`" + n + "`", orDash(p.Type), orDash(req), cell(desc)})
	}
	return markdownTable(rows)
}

// cell makes a tool description safe to sit inside a markdown table.
//
// Two things bite inside a table. A description containing `|` — memory_remember's
// sourceType lists its values that way — silently adds columns, and the
// table stops being a table. And prettier normalises `*emphasis*` to
// `_emphasis_`, which would rewrite the generated page on every format
// run and turn the CI drift gate into a permanent false positive.
//
// Both are rewrites of the DISPLAY text only; the description sent to
// clients on tools/list is untouched, and renders identically either way.
func cell(desc string) string {
	return prose(strings.ReplaceAll(desc, "|", "\\|"))
}

// prose normalises a description for the page body. Only the emphasis
// rewrite applies here — pipes are ordinary characters outside a table.
func prose(desc string) string {
	return emphasis.ReplaceAllString(desc, "_${1}_")
}

// emphasis matches *single-asterisk* spans, not **bold**.
var emphasis = regexp.MustCompile(`\*([^*\n]+)\*`)

// markdownTable pads every column to its widest cell, which is what
// prettier does to a markdown table. The page is committed and CI
// regenerates it and diffs — so a generator that emitted unpadded rows
// would lose that diff to the formatter on every run, and the drift gate
// would report a change that is not one.
//
// Width is counted in runes, not bytes: these cells carry em dashes and
// the odd non-ASCII description, and byte lengths would pad them short.
func markdownTable(rows [][4]string) string {
	var w [4]int
	for _, r := range rows {
		for i, cell := range r {
			if n := len([]rune(cell)); n > w[i] {
				w[i] = n
			}
		}
	}
	pad := func(s string, width int) string {
		return s + strings.Repeat(" ", width-len([]rune(s)))
	}
	var b strings.Builder
	for i, r := range rows {
		fmt.Fprintf(&b, "| %s | %s | %s | %s |\n",
			pad(r[0], w[0]), pad(r[1], w[1]), pad(r[2], w[2]), pad(r[3], w[3]))
		if i == 0 {
			fmt.Fprintf(&b, "| %s | %s | %s | %s |\n",
				strings.Repeat("-", w[0]), strings.Repeat("-", w[1]),
				strings.Repeat("-", w[2]), strings.Repeat("-", w[3]))
		}
	}
	return b.String()
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "gen-tool-docs: "+format+"\n", a...)
	os.Exit(1)
}
