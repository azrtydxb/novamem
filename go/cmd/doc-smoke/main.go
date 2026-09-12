// doc-smoke — documentation invariants, guarding the high-risk stale
// claims that caused real drift in the past (issue #73).
//
// Ported from scripts/doc-smoke.mjs. It moved to Go because the checks
// increasingly compare documentation against things only Go knows: the
// config registry, the advertised tool definitions, the generated
// OpenAPI document. Keeping half the invariants in Node meant either a
// second copy of those sources or a Node job that shells into Go — the
// latter broke CI twice in one afternoon.
//
// Output is `<file>:<line> — <what is wrong>`, sorted, exit 1 on any
// failure.
package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/docaudit"
)

// root is the repository root, relative to go/ where this is run.
const root = ".."

// docTargets are the roots scanned for doc-content invariants. Files
// outside these are not subject to them; the whole-tree sweep below is
// separate and wider.
var docTargets = []string{
	"docs", "packages/docs-site", "skills",
	"README.md", "CLAUDE.md", "CONTRIBUTING.md",
}

var failures []string

func fail(file string, line int, format string, a ...any) {
	loc := file
	if line > 0 {
		loc = fmt.Sprintf("%s:%d", file, line)
	}
	failures = append(failures, loc+" — "+fmt.Sprintf(format, a...))
}

func main() {
	docs := docFiles()

	checkNoSecondCopyOfDocs()
	checkAPIReferenceVersionsAgree()
	checkToolProseNamesNoPhantomTools()
	failures = append(failures, docaudit.EnvVars(filepath.Join(root, "docs"), root)...)

	for _, file := range docs {
		lines := readLines(file)
		checkPublicHealthShape(file, lines)
		checkDeepHealthPath(file, lines)
		checkProjectShareWording(file, lines)
		checkLifecycleAdminOnly(file, lines)
		checkNoStaleTenantAdminDocs(file, lines)
		checkNoReviewMarkers(file, lines)
		checkEndpointsExist(file, lines)
	}

	// Whole-tree sweep for stale trailers and deployment footguns.
	tree := treeFiles()
	for _, file := range tree {
		lines := readLines(file)
		checkDeployFootguns(file, lines)
		checkNoCoAuthoredByClaude(file, lines)
	}

	if len(failures) > 0 {
		sort.Strings(failures)
		fmt.Fprintf(os.Stderr, "doc-smoke: %d failure(s):\n\n", len(failures))
		for _, f := range failures {
			fmt.Fprintf(os.Stderr, "  %s\n", f)
		}
		fmt.Fprintln(os.Stderr)
		os.Exit(1)
	}
	fmt.Printf("doc-smoke: OK (scanned %d doc file(s), %d tree file(s))\n", len(docs), len(tree))
}

// ── File discovery ───────────────────────────────────────────────────

var docExt = regexp.MustCompile(`(?i)\.(md|mdx|markdown|txt)$`)

func docFiles() []string {
	seen := map[string]bool{}
	var out []string
	add := func(f string) {
		if !seen[f] {
			seen[f], out = true, append(out, f)
		}
	}
	for _, t := range docTargets {
		for _, f := range walk(t, docExt, func(name string) bool {
			// Dotfiles, node_modules and build output are not documentation.
			return strings.HasPrefix(name, ".") || name == "node_modules" || name == "dist"
		}) {
			add(f)
		}
	}
	// Per-package READMEs are public surface too.
	entries, err := os.ReadDir(filepath.Join(root, "packages"))
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			readme := filepath.ToSlash(filepath.Join("packages", e.Name(), "README.md"))
			if _, err := os.Stat(filepath.Join(root, readme)); err == nil {
				add(readme)
			}
		}
	}
	sort.Strings(out)
	return out
}

var treeExt = regexp.MustCompile(`(?i)\.(md|mdx|markdown|txt|yml|yaml|json|ts|tsx|js|mjs|cjs|sh|go)$`)

var treeSkip = map[string]bool{
	".git": true, "node_modules": true, ".claude": true, ".kilo": true,
	".kilocode": true, "dist": true, ".turbo": true, ".next": true,
	"coverage": true, "pnpm-lock.yaml": true,
}

func treeFiles() []string {
	out := walk(".", treeExt, func(name string) bool { return treeSkip[name] })
	sort.Strings(out)
	return out
}

// walk returns repo-relative paths under rel whose name matches ext,
// skipping any directory or file the skip predicate rejects.
func walk(rel string, ext *regexp.Regexp, skip func(name string) bool) []string {
	abs := filepath.Join(root, rel)
	st, err := os.Stat(abs)
	if err != nil {
		return nil
	}
	if !st.IsDir() {
		return []string{filepath.ToSlash(rel)}
	}
	var out []string
	_ = filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if skip(d.Name()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !ext.MatchString(d.Name()) {
			return nil
		}
		if r, err := filepath.Rel(filepath.Join(root), path); err == nil {
			out = append(out, filepath.ToSlash(r))
		}
		return nil
	})
	return out
}

func readLines(rel string) []string {
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		return nil
	}
	return strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
}

// window joins the lines around i, inclusive, for checks that allow a
// nearby clarification to excuse a line.
func window(lines []string, i, before, after int) string {
	lo, hi := max(0, i-before), min(len(lines), i+after+1)
	return strings.Join(lines[lo:hi], "\n")
}
