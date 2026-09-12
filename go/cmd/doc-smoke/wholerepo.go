package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// `docs/` is the single source the VitePress site builds from (srcDir in
// packages/docs-site/.vitepress/config.mts). Before that, the same pages
// were maintained by hand in both places and drifted in both directions —
// the site knew about pgvector and memory_relations while docs/ still
// described FalkorDB, and docs/ had a whole pgvector Kubernetes section
// the site had never seen. Nobody predicted either drift, because a
// second copy drifts silently by construction.
//
// So: no page may exist under packages/docs-site/ at all. The package
// holds the config and the static assets, nothing readable.
func checkNoSecondCopyOfDocs() {
	for _, f := range walk("packages/docs-site", regexp.MustCompile(`(?i)\.md$`),
		func(name string) bool { return name == "node_modules" || name == "dist" }) {
		fail(f, 1, "a page under packages/docs-site/ — docs/ is the only source the "+
			"site builds from; move it to docs/ so there is one copy")
	}
}

// The API reference renders on two surfaces: the site bundles Scalar
// through packages/docs-site, and the server embeds its own copy and
// serves it at /api-docs so an air-gapped deployment still has a
// reference. Two copies of a version number is exactly the shape that
// drifts, and a reader landing on one surface would silently get a
// different renderer than the other. The embedded VERSION is the source;
// the site must depend on the same one.
func checkAPIReferenceVersionsAgree() {
	const versionFile = "go/internal/httpapi/apidocs/VERSION"
	const pkg = "packages/docs-site/package.json"

	b, err := os.ReadFile(filepath.Join(root, versionFile))
	if err != nil {
		fail(versionFile, 1, "missing — run go/scripts/sync-api-reference.sh")
		return
	}
	embedded := strings.TrimSpace(string(b))

	lines := readLines(pkg)
	idx := -1
	for i, l := range lines {
		if strings.Contains(l, `"@scalar/api-reference"`) {
			idx = i
			break
		}
	}
	if idx < 0 {
		fail(pkg, 1, "does not depend on @scalar/api-reference — the interactive reference page cannot render")
		return
	}
	m := regexp.MustCompile(`"@scalar/api-reference":\s*"([^"]+)"`).FindStringSubmatch(lines[idx])
	pinned := ""
	if m != nil {
		pinned = m[1]
	}
	if pinned != embedded {
		fail(pkg, idx+1, "pins @scalar/api-reference %s but the server embeds %s (%s) — "+
			"the site and /api-docs must render with the same version", pinned, embedded, versionFile)
	}
}

// The tool catalogue in docs/api/mcp-tools.md is GENERATED from
// tooldefs.json (`go run ./cmd/gen-tool-docs`, with a CI drift gate), so
// it cannot disagree with the surface and needs no check here.
//
// The skill reference pages cannot be generated — they are deep-dives
// with worked examples, which is prose by nature. What they must never
// do is name a tool that does not exist: a reader following a reference
// to a removed tool gets a call that fails with no clue why. So this
// checks one direction only, which is the direction prose can get wrong
// without anyone noticing.
var toolProseDocs = []string{
	"skills/novamem/references/search.md",
	"skills/novamem/references/remember.md",
	"skills/novamem/references/projects.md",
}

var toolMention = regexp.MustCompile("`((?:memory|project)_[a-z_]+)`")

// nonToolIdentifiers share the tools' naming shape without being tools.
// There is no generated source to derive these from — `memoryType`
// values exist only in stored metadata and prose — so they are declared
// here with their reason, and the check fails if one ever becomes a real
// tool, which would make the exemption a blindfold.
var nonToolIdentifiers = map[string]string{
	"project_convention": "a memoryType value (references/remember.md), not a tool",
}

func checkToolProseNamesNoPhantomTools() {
	const defsPath = "go/internal/mcp/tooldefs.json"
	b, err := os.ReadFile(filepath.Join(root, defsPath))
	if err != nil {
		fail(defsPath, 1, "unreadable, so the tool docs cannot be checked: %v", err)
		return
	}
	var defs []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(b, &defs); err != nil {
		fail(defsPath, 1, "unparseable, so the tool docs cannot be checked: %v", err)
		return
	}
	advertised := map[string]bool{}
	for _, d := range defs {
		advertised[d.Name] = true
	}

	for name, why := range nonToolIdentifiers {
		if advertised[name] {
			fail("go/cmd/doc-smoke/wholerepo.go", 1,
				"nonToolIdentifiers exempts `%s` as %q, but it is now an advertised tool — "+
					"remove the exemption or the docs stop being checked for it", name, why)
		}
	}

	for _, file := range toolProseDocs {
		lines := readLines(file)
		if lines == nil {
			fail(file, 1, "missing — it is part of the skill bundle and is required")
			continue
		}
		text := strings.Join(lines, "\n")
		named := map[string]bool{}
		for _, m := range toolMention.FindAllStringSubmatch(text, -1) {
			named[m[1]] = true
		}
		names := make([]string, 0, len(named))
		for n := range named {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, name := range names {
			if advertised[name] {
				continue
			}
			if _, exempt := nonToolIdentifiers[name]; exempt {
				continue
			}
			line := 1
			for i, l := range lines {
				if strings.Contains(l, "`"+name+"`") {
					line = i + 1
					break
				}
			}
			fail(file, line, "documents `%s`, which is not an advertised MCP tool", name)
		}
	}
}
