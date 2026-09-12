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

	// AFTER the pages are written, not before. Auditing first deadlocks
	// on the very change the audit exists to support: removing a
	// variable leaves its name in the committed env-reference.md, so a
	// pre-write audit fails on the stale page and exits before it can
	// regenerate the page that would have removed the name.
	auditDocs()
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
		parts = append(parts, requiredClause(v))
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
		checkUnimplementedPrefixes(rel, string(src), &problems)
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
	for _, e := range templateExtras {
		b.WriteString("\n" + comment(e.description) + e.name + "=" + e.example + "\n")
	}
	for _, v := range config.Vars {
		// Conditionally required variables belong with their subsystem,
		// not here: a deployment that never enables the observer should
		// not be shown an empty NOVAMEM_OBSERVER_MODEL at the top of
		// the file as though it were missing something. What does belong
		// here is a condition that already holds untouched.
		if !v.NeededByDefault && !v.TemplateLive {
			continue
		}
		clause := ""
		if v.Required != "" {
			clause = " " + requiredClause(v)
		}
		b.WriteString("\n" + comment(v.Description+clause) + v.Name + "=" + v.Example + "\n")
	}

	for _, section := range sectionsInOrder() {
		var rows []config.Var
		for _, v := range config.Vars {
			if v.Section == section && !v.NeededByDefault && !v.TemplateLive && v.Deprecated == "" {
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
	out := b.String()
	checkNoAmbiguousLines(out)
	checkComposeIsSatisfiable(out)
	if err := os.WriteFile(envExamplePath, []byte(out), 0o644); err != nil {
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
	// Description lines are indented past the comment marker so they can
	// never be mistaken for a commented-out assignment. Unindented, a
	// wrapped sentence ending in "Required when NOVAMEM_AUTH_MODE=bearer."
	// begins its last line with `# NOVAMEM_AUTH_MODE=bearer.` — which is
	// exactly the shape of a setting waiting to be uncommented, trailing
	// full stop and all.
	const prefix = "#  "
	var b strings.Builder
	line := prefix
	for _, word := range strings.Fields(s) {
		if len(line)+1+len(word) > 74 && line != prefix {
			b.WriteString(line + "\n")
			line = prefix
		}
		line += " " + word
	}
	if line != prefix {
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

// assignmentLine matches a line that reads as a setting, commented out
// or not — which is exactly what a reader scans for when deciding what
// to uncomment.
var assignmentLine = regexp.MustCompile(`(?m)^(?:# )?([A-Z][A-Z0-9_]*)=`)

// checkNoAmbiguousLines refuses to write a template in which the same
// variable appears to be assigned twice.
//
// The failure it caught: descriptions were wrapped at column 74 with no
// indent, so a sentence ending "Required when NOVAMEM_AUTH_MODE=bearer."
// put `# NOVAMEM_AUTH_MODE=bearer.` on its own line — indistinguishable
// from a setting waiting to be uncommented, and one that would have
// been rejected at startup with a baffling message about a trailing full
// stop. Indenting the prose fixed it; this makes sure it stays fixed,
// including for a description not yet written.
func checkNoAmbiguousLines(out string) {
	seen := map[string]bool{}
	var dupes []string
	for _, m := range assignmentLine.FindAllStringSubmatch(out, -1) {
		if seen[m[1]] {
			dupes = append(dupes, m[1])
			continue
		}
		seen[m[1]] = true
	}
	if len(dupes) > 0 {
		sort.Strings(dupes)
		fail("%s would assign these twice: %s\n\n"+
			"Almost certainly a description wrapped so that a line begins with "+
			"NAME=, which reads as a second setting. Prose lines are indented "+
			"past the comment marker to prevent exactly this.",
			envExamplePath, strings.Join(dupes, ", "))
	}
}

// templateExtras are variables .env.example must carry that the SERVER
// does not read, so they have no place in the config registry.
//
// Dropping POSTGRES_PASSWORD from the generated template broke the
// documented `cp .env.example .env && docker compose up` flow outright:
// docker-compose.yaml interpolates it into both the postgres service and
// NOVAMEM_WARM_URL with `:?`, so Compose aborts before anything starts.
// A template that the quickstart cannot use is a worse failure than the
// drift this generator was written to remove.
//
// They stay out of the reference table, which documents what the server
// reads; the page names them in its hand-written notes instead.
var templateExtras = []struct{ name, example, description string }{
	{
		name:    "POSTGRES_PASSWORD",
		example: "CHANGE_ME",
		description: "Read by Docker Compose, not by the server: it is interpolated " +
			"into the postgres service and into NOVAMEM_WARM_URL below. Compose " +
			"refuses to start without it. Ignored outside Compose — a Kubernetes " +
			"or manual install sets NOVAMEM_WARM_URL directly.",
	},
}

const composePath = "../docker-compose.yaml"

// composeRequired matches a Compose interpolation that aborts the stack
// when the variable is unset: ${VAR:?message}.
var composeRequired = regexp.MustCompile(`\$\{([A-Z_][A-Z0-9_]*):\?`)

// templateAssignment matches a live (uncommented) assignment.
var templateAssignment = regexp.MustCompile(`(?m)^([A-Z][A-Z0-9_]*)=`)

// checkComposeIsSatisfiable refuses to write a template that the
// documented quickstart cannot use.
//
// `cp .env.example .env && docker compose up` is the first thing a new
// user runs. Compose interpolates POSTGRES_PASSWORD and
// NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD with `:?`, so it aborts before
// starting anything if either is missing from the file — and a variable
// that is merely commented out is missing. Generating this template from
// the server's registry dropped POSTGRES_PASSWORD entirely, because the
// server does not read it; that is how a single-source refactor breaks
// the quickstart while every test still passes.
//
// The fix is not to hardcode the two names here: it is to check them
// against the Compose file, so a new `:?` interpolation added there
// fails this generator until the template carries it.
func checkComposeIsSatisfiable(template string) {
	compose, err := os.ReadFile(composePath)
	if err != nil {
		// Not fatal: the generator must still work in a checkout where
		// the Compose file has been moved or removed.
		fmt.Fprintf(os.Stderr, "gen-env-docs: skipping the compose check: %v\n", err)
		return
	}
	live := map[string]bool{}
	for _, m := range templateAssignment.FindAllStringSubmatch(template, -1) {
		live[m[1]] = true
	}
	// Deduped: Compose interpolates POSTGRES_PASSWORD into both the
	// postgres service and NOVAMEM_WARM_URL, and naming it twice in the
	// error reads like two separate problems.
	seen := map[string]bool{}
	var missing []string
	for _, m := range composeRequired.FindAllStringSubmatch(string(compose), -1) {
		if !live[m[1]] && !seen[m[1]] {
			seen[m[1]] = true
			missing = append(missing, m[1])
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		fail("docker-compose.yaml aborts without %s, but %s does not set %s.\n\n"+
			"`cp .env.example .env && docker compose up` is the documented quickstart "+
			"and would fail before anything starts. Give the variable a live line: set "+
			"NeededByDefault (the server requires it) or TemplateLive (only a deploy "+
			"path does) in registry.go, or add it to templateExtras if the server never "+
			"reads it.",
			strings.Join(missing, ", "), envExamplePath, strings.Join(missing, " or "))
	}
}

// otelVar matches an OpenTelemetry configuration variable.
//
// The four the server reads are declared in registry.go like any other,
// so they pass the ordinary rule. This exists for the ones it does NOT
// read: OTEL defines dozens — OTEL_METRICS_EXPORTER, OTEL_TRACES_SAMPLER,
// OTEL_RESOURCE_ATTRIBUTES — and documenting one novamem ignores is the
// exact failure #277 was opened for. docs/observability.md described
// OTLP export driven by variables the Go server read none of, so an
// operator following it got silence, which is the worst failure an
// observability setting has: indistinguishable from a working exporter
// with nothing to report.
//
// A page may still name an unread OTEL variable — it just has to say so.
var otelVar = regexp.MustCompile(`OTEL_[A-Z0-9_]*[A-Z0-9]`)

// notImplementedMarker is the page saying so in its own words. Matched
// loosely on purpose — the requirement is that a reader is told, not
// that they are told in one blessed phrasing.
var notImplementedMarker = regexp.MustCompile(`(?i)not implemented|no OpenTelemetry|does nothing|reads no`)

// checkUnimplementedPrefixes requires an OTEL variable to be either
// declared — and therefore read — or described on the page as something
// novamem does not act on.
//
// Deliberately NOT "never mention it". A page discussing collector setup
// may reasonably name a variable the collector reads and novamem does
// not. A SILENT mention is what is not allowed, because it reads as
// configuration.
func checkUnimplementedPrefixes(rel, src string, problems *[]string) {
	for _, name := range otelVar.FindAllString(src, -1) {
		if _, declared := config.Lookup(name); declared {
			continue // the exporter exists now; ordinary rules apply
		}
		if notImplementedMarker.MatchString(src) {
			break // the page says so; one marker covers the page
		}
		*problems = append(*problems, fmt.Sprintf(
			"%s names %s, which is not declared in registry.go and is not marked "+
				"as unimplemented on that page — a reader would set it and get silence",
			rel, name))
		break
	}
}
