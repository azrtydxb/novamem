// gen-env-docs renders docs/install/env-reference.md from the config
// registry in go/internal/config/registry.go.
//
// The page used to carry a hand-written table, and it had drifted from
// the loader in ways that made it actively misleading: it advertised an
// `NOVAMEM_AUTH_MODE=tenant` the loader rejects, named
// `local-transformers` as the embeddings default when the loader refuses
// to start on it, documented `NOVAMEM_EMBEDDINGS_RECONCILE_BATCH` as 50
// against the loader's 400, and described a `NOVAMEM_CORS_ORIGINS`
// default of empty when unset actually allows a dev origin. It also
// documented two `OTEL_*` variables no code reads, and omitted more than
// twenty variables the server does read.
//
// None of that is fixable by proof-reading, because a second copy of a
// default has no way to notice the first one changed. So the defaults
// have one home — the registry — and this renders them.
//
// Only the region between the markers is generated. The prose around it
// — the warning about swapping embedding models, the pointers to the
// install guides — is genuinely explanatory and stays hand-written.
//
// Run it, then commit the result; CI regenerates and fails on a dirty
// tree, exactly as it does for docs/api/openapi.json.
package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/config"
)

const (
	markerStart = "<!-- env-reference:start -->"
	markerEnd   = "<!-- env-reference:end -->"
	docPath     = "../docs/install/env-reference.md"
)

func main() {
	auditDocs()

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
		render() + "\n" + string(page[end:])
	if err := os.WriteFile(docPath, []byte(out), 0o644); err != nil {
		fail("writing %s: %v", docPath, err)
	}
	fmt.Printf("wrote %s (%d variables)\n", docPath, len(config.Vars))

	writeEnvExample()
}

func render() string {
	var b strings.Builder
	fmt.Fprintf(&b, "_%d variables. This section is generated from "+
		"[`go/internal/config/registry.go`](https://github.com/azrtydxb/novamem/blob/main/go/internal/config/registry.go) "+
		"by `go run ./cmd/gen-env-docs` — the defaults below are the ones the loader applies, not a second copy of them. "+
		"Add or change a variable there, not here._\n", len(config.Vars))

	// Required-first, because an operator reading this page top to
	// bottom needs the four things that stop the server before the
	// sixty that tune it.
	b.WriteString("\n## Required settings\n\n")
	b.WriteString("Each of these is required under the condition named, and startup fails fast without it — " +
		"a server that cannot store, or cannot sign a session, refuses to boot rather than answering " +
		"every request with a 503. Only `NOVAMEM_WARM_URL` is unconditional.\n\n")
	var required [][]string
	for _, v := range config.Vars {
		if v.Required != "" {
			required = append(required, []string{code(v.Name), v.Required, firstSentence(v.Description)})
		}
	}
	b.WriteString(table([]string{"Variable", "Required when", "What it does"}, required))

	rendered := map[string]bool{}
	for _, section := range sectionsInOrder() {
		var rows [][]string
		for _, v := range config.Vars {
			if v.Section != section || v.Deprecated != "" {
				continue
			}
			rendered[v.Name] = true
			rows = append(rows, []string{code(v.Name), string(v.Kind), defaultCell(v), desc(v)})
		}
		if len(rows) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n## %s\n\n", section)
		b.WriteString(table([]string{"Variable", "Type", "Default", "Description"}, rows))
	}

	var deprecated [][]string
	for _, v := range config.Vars {
		if v.Deprecated == "" {
			continue
		}
		rendered[v.Name] = true
		deprecated = append(deprecated, []string{code(v.Name), code(v.Deprecated), desc(v)})
	}
	if len(deprecated) > 0 {
		b.WriteString("\n## Deprecated\n\n")
		b.WriteString("Still read, so an existing deployment keeps working. " +
			"Move to the supported spelling — these are removed on the next major.\n\n")
		b.WriteString(table([]string{"Variable", "Use instead", "Notes"}, deprecated))
	}

	// A variable in no rendered section would be counted in the header
	// and then silently left off the page — a reference that says 62 and
	// lists 61. Louder to stop than to under-report.
	for _, v := range config.Vars {
		if !rendered[v.Name] {
			fail("%s is in section %q, which is not in sectionsInOrder — add it", v.Name, v.Section)
		}
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}

// sectionsInOrder returns the declared section order, then any section
// the registry uses that the order list does not name, so a new section
// appears on the page instead of tripping the completeness check.
func sectionsInOrder() []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range config.SectionOrder() {
		if !seen[s] {
			seen[s], out = true, append(out, s)
		}
	}
	var extra []string
	for _, v := range config.Vars {
		if !seen[v.Section] {
			seen[v.Section] = true
			extra = append(extra, v.Section)
		}
	}
	sort.Strings(extra)
	return append(out, extra...)
}

// defaultCell renders the default the loader would apply. A derived
// default — one computed from other settings — is described rather than
// invented, because writing a literal there would be the same second
// copy this generator exists to remove.
func defaultCell(v config.Var) string {
	if v.DefaultNote != "" {
		return v.DefaultNote
	}
	switch d := v.Default.(type) {
	case nil:
		return "—"
	case string:
		if d == "" {
			return "—"
		}
		return code(d)
	case bool:
		if d {
			return "on"
		}
		return "off"
	case int:
		return code(strconv.Itoa(d))
	case float64:
		return code(strconv.FormatFloat(d, 'g', -1, 64))
	default:
		return code(fmt.Sprint(d))
	}
}

// desc is the description, prefixed with the accepted values for an
// enum and a warning for a credential.
func desc(v config.Var) string {
	var parts []string
	if len(v.Enum) > 0 {
		var named []string
		for _, e := range v.Enum {
			if e != "" {
				named = append(named, code(e))
			}
		}
		parts = append(parts, "One of "+strings.Join(named, ", ")+".")
	}
	parts = append(parts, v.Description)
	if v.Secret {
		parts = append(parts, "**Secret** — keep it out of a ConfigMap and out of a committed `.env`.")
	}
	if v.Required != "" {
		parts = append(parts, "Required when "+v.Required+".")
	}
	return strings.Join(parts, " ")
}

// firstSentence trims a description to its opening sentence for the
// summary table, where the full prose would bury the four rows that
// matter under a paragraph each.
func firstSentence(s string) string {
	for i, r := range s {
		if r != '.' || i+1 >= len(s) {
			continue
		}
		// Not a sentence end if it is a decimal point or inside a
		// dotted identifier — "auth.mode", "0.25", "e5-*".
		if next := s[i+1]; next == ' ' {
			return s[:i+1]
		}
	}
	return s
}

func code(s string) string { return "`" + s + "`" }

// table pads every column to its widest cell, which is what prettier
// does to a markdown table. The page is committed and CI regenerates it
// and diffs — so a generator that emitted unpadded rows would lose that
// diff to the formatter on every run, and the drift gate would report a
// change that is not one.
//
// Width is counted in runes, not bytes: these cells carry em dashes and
// arrows, and byte lengths would pad them short.
func table(header []string, rows [][]string) string {
	all := append([][]string{header}, rows...)
	w := make([]int, len(header))
	for _, r := range all {
		for i, c := range r {
			if n := len([]rune(escape(c))); n > w[i] {
				w[i] = n
			}
		}
	}
	var b strings.Builder
	write := func(cells []string) {
		b.WriteString("|")
		for i, c := range cells {
			c = escape(c)
			b.WriteString(" " + c + strings.Repeat(" ", w[i]-len([]rune(c))) + " |")
		}
		b.WriteString("\n")
	}
	write(header)
	b.WriteString("|")
	for _, width := range w {
		b.WriteString(" " + strings.Repeat("-", width) + " |")
	}
	b.WriteString("\n")
	for _, r := range rows {
		write(r)
	}
	return b.String()
}

// escape makes a cell safe inside a markdown table. A description
// containing `|` — the embeddings provider prose lists its values that
// way — would silently add columns and the table would stop being a
// table. This rewrites the DISPLAY text only.
func escape(s string) string {
	return strings.ReplaceAll(s, "|", "\\|")
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "gen-env-docs: "+format+"\n", a...)
	os.Exit(1)
}

// ---------------------------------------------------------------------
// The other direction. Generating the reference page guarantees every
// DECLARED variable is documented; it says nothing about a page
// elsewhere in docs/ naming a variable the server does not read.
//
// That is not hypothetical. docs/ops/hardening.md asked operators to
// enable OTLP tracing the Go server has no code for;
// docs/architecture/decay.md described the dream cycle as configurable
// via NOVAMEM_DREAM_INTERVAL_MS, a variable that does not exist and
// never did in Go. Both read as instructions. An operator following
// them sets a variable, sees nothing happen, and has no way to tell a
// broken deployment from a documented feature that was never built.
//
// So: every NOVAMEM_* name anywhere in docs/ must be a declared server
// variable or an explicitly listed non-server one.
// ---------------------------------------------------------------------

const docsRoot = "../docs"

// novamemVar matches a NOVAMEM_* name in prose, including the family
// form prose uses to refer to a group — `NOVAMEM_RERANK_*`. The two are
// told apart by the captured suffix: a family is checked against the
// declared names by prefix, so `NOVAMEM_RERANK_*` still fails once no
// rerank variable is left.
var novamemVar = regexp.MustCompile(`NOVAMEM_[A-Z0-9_]*[A-Z0-9](_\*)?`)

// notServerConfig are NOVAMEM_* names that are real, documented, and
// deliberately not in the registry because the server does not read
// them. Each says who does, so the list cannot quietly become a
// dumping ground for whatever the audit happens to trip on.
var notServerConfig = map[string]string{
	"NOVAMEM_TOKEN":      "client credential, read by cmd/novamem-mcp",
	"NOVAMEM_PASSWORD":   "client credential, read by cmd/novamem-init",
	"NOVAMEM_MCP_BIN":    "client shim path, read by internal/initcli",
	"NOVAMEM_URL":        "conformance target, read by the conformance module",
	"NOVAMEM_TEST_TOKEN": "conformance credential, read by the conformance module",
	"NOVAMEM_BIN_DIR":    "install location, read by the install script",
	"NOVAMEM_VERSION":    "release tag, read by the install script",
}

// historical are paths whose job is to record what was true at a point
// in time. A changelog entry naming a variable that has since been
// removed is correct as written, and rewriting it would be falsifying
// the record rather than fixing a document.
var historical = []string{
	"docs/reference/changelog.md",
	"docs/superpowers/",
	"docs/architecture/go-parity-audit.md",
}

func auditDocs() {
	var problems []string
	err := filepath.WalkDir(docsRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".md") {
			return err
		}
		rel := filepath.ToSlash(strings.TrimPrefix(path, "../"))
		for _, h := range historical {
			if strings.HasPrefix(rel, h) {
				return nil
			}
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, name := range novamemVar.FindAllString(string(src), -1) {
			if seen[name] {
				continue
			}
			seen[name] = true
			if prefix, isFamily := strings.CutSuffix(name, "_*"); isFamily {
				if !anyDeclaredWithPrefix(prefix) {
					problems = append(problems, fmt.Sprintf(
						"%s refers to the %s_* family, but no such variable is declared", rel, prefix))
				}
				continue
			}
			if _, ok := config.Lookup(name); ok {
				continue
			}
			if _, ok := notServerConfig[name]; ok {
				continue
			}
			problems = append(problems, fmt.Sprintf("%s names %s, which the server does not read", rel, name))
		}
		return nil
	})
	if err != nil {
		fail("walking %s: %v", docsRoot, err)
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		fail("documentation describes variables that do not exist:\n  %s\n\n"+
			"Either add a row to go/internal/config/registry.go, or correct the page. "+
			"If the name is real but not server config, list it in notServerConfig with "+
			"a note saying what reads it.", strings.Join(problems, "\n  "))
	}
}

func anyDeclaredWithPrefix(prefix string) bool {
	for _, v := range config.Vars {
		if strings.HasPrefix(v.Name, prefix) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------
// .env.example
//
// The third hand-maintained copy of this surface, and the one that had
// rotted furthest: it set NOVAMEM_EMBEDDINGS_PROVIDER=local-transformers,
// which the loader refuses to start on, so copying the annotated
// template produced a server that would not boot. It also set
// NOVAMEM_GRAPH_ENABLED and NOVAMEM_GRAPH_URL, pointing at a Redis graph
// tier the Go server has no code for, and explained that auth.mode=none
// generates an ephemeral cookie secret, which it does not.
//
// Generated from the same table, under one rule: a copied file changes
// nothing. Optional variables are written commented out, showing the
// default the server would apply anyway, so uncommenting one is a
// deliberate act. Only the variables with no working default — the ones
// startup refuses to proceed without — are left live for the operator to
// fill in.
// ---------------------------------------------------------------------

const envExamplePath = "../.env.example"

func writeEnvExample() {
	var b strings.Builder
	b.WriteString(`# novamem environment variables. Copy to ` + "`.env`" + ` and edit, or feed them
# through your deployment system.
#
# GENERATED from go/internal/config/registry.go by ` + "`go run ./cmd/gen-env-docs`" + `.
# Edit the registry, not this file. Every variable the server reads is
# here; anything not listed is ignored.
#
# Optional variables are commented out and show the default the server
# applies anyway, so an untouched copy of this file behaves exactly like
# no file at all. The live lines at the top are the ones with no usable
# default — fill them in or the server refuses to start.
#
# See docs/install/env-reference.md for the same table with prose, and
# SECURITY.md for the production hardening checklist.

# ═══ Required ════════════════════════════════════════════════════════
`)
	for _, v := range config.Vars {
		// Conditionally required variables belong with their subsystem,
		// not here: a deployment that never enables the observer should
		// not be shown an empty NOVAMEM_OBSERVER_MODEL at the top of
		// the file as though it were missing something. What does belong
		// here is a condition that already holds untouched.
		if !v.NeededByDefault {
			continue
		}
		b.WriteString("\n" + comment(v.Description+" "+requiredClause(v)) +
			v.Name + "=" + v.Example + "\n")
	}

	for _, section := range sectionsInOrder() {
		var rows []config.Var
		for _, v := range config.Vars {
			if v.Section == section && !v.NeededByDefault && v.Deprecated == "" {
				rows = append(rows, v)
			}
		}
		if len(rows) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n# ═══ %s %s\n", section, strings.Repeat("═", max(3, 66-len(section))))
		for _, v := range rows {
			b.WriteString("\n" + comment(desc(v)) + "# " + v.Name + "=" + v.ShellDefault() + "\n")
		}
	}
	if err := os.WriteFile(envExamplePath, []byte(b.String()), 0o644); err != nil {
		fail("writing %s: %v", envExamplePath, err)
	}
	fmt.Printf("wrote %s\n", envExamplePath)
}

// comment turns a description into wrapped `# ` lines, with the
// markdown stripped: backticks and bold markers are noise in a shell
// file, and a reader sees them as literal characters.
func comment(s string) string {
	// Backticks and bold markers are markdown noise in a shell file.
	// Underscores are NOT stripped: they are part of every variable
	// name, and removing them turned NOVAMEM_AUTH_MODE into
	// NOVAMEMAUTHMODE in the first generated template.
	s = strings.NewReplacer("`", "", "**", "").Replace(s)
	var b strings.Builder
	line := "#"
	for _, word := range strings.Fields(s) {
		if len(line)+1+len(word) > 74 && line != "#" {
			b.WriteString(line + "\n")
			line = "#"
		}
		line += " " + word
	}
	if line != "#" {
		b.WriteString(line + "\n")
	}
	return b.String()
}

// requiredClause reads as a sentence in both forms: "always" is a
// condition in the table and a statement in prose.
func requiredClause(v config.Var) string {
	if v.Required == "always" {
		return "Always required."
	}
	return "Required when " + v.Required + "."
}
