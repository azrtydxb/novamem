// Package docaudit holds the documentation invariants that have to be
// checked against Go source of truth — the config registry, the tool
// definitions, the generated OpenAPI document.
//
// It exists because those checks kept landing in whichever command
// needed them first. The environment audit was written inside
// cmd/gen-env-docs, so `pnpm docs:smoke` never ran it; wiring that up
// made a Node-only CI job depend on the Go toolchain. One package, two
// callers: the generator, which audits after it writes, and
// cmd/doc-smoke, which is what CI and contributors run.
package docaudit

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/config"
)

// novamemVar matches a NOVAMEM_* name in prose, including the family
// form prose uses to refer to a group — `NOVAMEM_RERANK_*`. The two are
// told apart by the captured suffix: a family is checked against the
// declared names by prefix, so `NOVAMEM_RERANK_*` still fails once no
// rerank variable is left.
var novamemVar = regexp.MustCompile(`NOVAMEM_[A-Z0-9_]*[A-Z0-9](_\*)?`)

// otelVar matches an OpenTelemetry configuration variable.
//
// The four the server reads are declared in registry.go like any other,
// so they pass the ordinary rule. This exists for the ones it does NOT
// read: OTEL defines dozens — OTEL_METRICS_EXPORTER, OTEL_TRACES_SAMPLER,
// OTEL_RESOURCE_ATTRIBUTES — and documenting one novamem ignores is the
// exact failure #277 was opened for.
var otelVar = regexp.MustCompile(`OTEL_[A-Z0-9_]*[A-Z0-9]`)

// notImplementedMarker is the page saying so in its own words. Matched
// loosely on purpose — the requirement is that a reader is told, not
// that they are told in one blessed phrasing.
var notImplementedMarker = regexp.MustCompile(`(?i)not implemented|no OpenTelemetry|does nothing|reads no|ignored by novamem`)

// notServerConfig are NOVAMEM_* names that are real, documented, and
// deliberately not in the registry because the server does not read
// them. Each says who does, so the list cannot quietly become a dumping
// ground for whatever the audit happens to trip on.
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

// EnvVars reports pages that name an environment variable the server
// does not read.
//
// docsRoot is the directory to walk; rel paths in the returned problems
// are relative to the repository root, so a message can be pasted into
// an editor.
func EnvVars(docsRoot, repoRoot string) []string {
	var problems []string
	err := filepath.WalkDir(docsRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".md") {
			return err
		}
		rel := relTo(repoRoot, path)
		for _, h := range historical {
			if strings.HasPrefix(rel, h) {
				return nil
			}
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		checkOTEL(rel, string(src), &problems)
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
			problems = append(problems, fmt.Sprintf(
				"%s names %s, which the server does not read", rel, name))
		}
		return nil
	})
	if err != nil {
		problems = append(problems, fmt.Sprintf("walking %s: %v", docsRoot, err))
	}
	sort.Strings(problems)
	return problems
}

// checkOTEL requires an OTEL variable to be either declared — and
// therefore read — or described on the page as something novamem does
// not act on.
//
// Deliberately NOT "never mention it". A page discussing collector setup
// may reasonably name a variable the collector reads and novamem does
// not. A SILENT mention is what is not allowed, because it reads as
// configuration.
func checkOTEL(rel, src string, problems *[]string) {
	for _, name := range otelVar.FindAllString(src, -1) {
		if _, declared := config.Lookup(name); declared {
			continue
		}
		if markedNearby(src, name) {
			continue
		}
		*problems = append(*problems, fmt.Sprintf(
			"%s names %s, which is not declared in registry.go and is not marked "+
				"as unimplemented on that page — a reader would set it and get silence",
			rel, name))
		return
	}
}

// markedNearby reports whether the disclaimer sits close enough to the
// mention to be read as being about it.
//
// Matching the whole page was wrong, and wrong in the dangerous
// direction: docs/architecture/multi-tenancy.md already says quotas are
// "not implemented", so adding an OTEL setting anywhere on that page
// would have passed the check while telling a reader nothing.
//
// The window is the paragraph the mention sits in plus the one on either
// side, which covers the real shapes: a disclaimer in the sentence, in a
// preceding banner, or in a note directly under a table row.
func markedNearby(src, name string) bool {
	paras := strings.Split(src, "\n\n")
	for i, p := range paras {
		if !strings.Contains(p, name) {
			continue
		}
		lo, hi := max(0, i-1), min(len(paras), i+2)
		if notImplementedMarker.MatchString(strings.Join(paras[lo:hi], "\n\n")) {
			continue
		}
		return false
	}
	return true
}

func anyDeclaredWithPrefix(prefix string) bool {
	for _, v := range config.Vars {
		if strings.HasPrefix(v.Name, prefix) {
			return true
		}
	}
	return false
}

// relTo renders path relative to root with forward slashes, falling back
// to the path as given when it is not under root.
func relTo(root, path string) string {
	if r, err := filepath.Rel(root, path); err == nil {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(path)
}
