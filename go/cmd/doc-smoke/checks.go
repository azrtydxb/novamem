package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// 1. Public /health is `{ ok }` only — never `{ ok, deps }`.
var (
	healthPath     = regexp.MustCompile(`/health\b`)
	deepHealthPath = regexp.MustCompile(`/admin/health/deep`)
	okDeps         = regexp.MustCompile(`\{\s*ok\s*,\s*deps\b`)
)

func checkPublicHealthShape(file string, lines []string) {
	for i, line := range lines {
		if healthPath.MatchString(line) && !deepHealthPath.MatchString(line) && okDeps.MatchString(line) {
			fail(file, i+1, "public /health described with `{ ok, deps }` — should be `{ ok }` only")
		}
	}
}

// 2. Deep dependency health must be `/v1/admin/health/deep`.
//
// The JS original used lookbehind, which RE2 has no equivalent for. The
// rule is the same: find each occurrence and look at what precedes it,
// which is what a lookbehind was expressing anyway.
func checkDeepHealthPath(file string, lines []string) {
	for i, line := range lines {
		for _, loc := range regexp.MustCompile(`/health/deep\b`).FindAllStringIndex(line, -1) {
			if !strings.HasSuffix(line[:loc[0]], "/v1/admin") {
				fail(file, i+1, "deep health endpoint must be `/v1/admin/health/deep`")
			}
		}
		for _, loc := range regexp.MustCompile(`/admin/health/deep\b`).FindAllStringIndex(line, -1) {
			if !strings.HasSuffix(line[:loc[0]], "/v1") {
				fail(file, i+1, "deep health endpoint must be `/v1/admin/health/deep` (missing `/v1/` prefix)")
			}
		}
	}
}

// 3. Project-sharing docs must say "exact email" / "exact invitee email".
var (
	shareContext  = regexp.MustCompile(`project_share|project_unshare|/projects/[^\s]*/share`)
	canonicalWord = regexp.MustCompile(`(?i)exact (invitee )?email`)
	usernameWord  = regexp.MustCompile(`(?i)\busername\b`)
	displayName   = regexp.MustCompile(`(?i)\bdisplay name\b`)
)

func checkProjectShareWording(file string, lines []string) {
	for i, line := range lines {
		if !shareContext.MatchString(line) {
			continue
		}
		// A literal `username` parameter in a code block is fine when the
		// canonical wording is nearby; the window is what allows that.
		if canonicalWord.MatchString(window(lines, i, 3, 3)) {
			continue
		}
		if usernameWord.MatchString(line) {
			fail(file, i+1, "project share/unshare docs reference `username` — should be exact invitee email")
		}
		if displayName.MatchString(line) {
			fail(file, i+1, "project share/unshare docs reference `display name` — should be exact invitee email")
		}
	}
}

// 4. Lifecycle endpoints must not be described as public/unauthenticated.
var (
	lifecycleEndpoints = []string{"/v1/decay", "/v1/dream-cycle", "/v1/reap-orphans"}
	contradictions     = regexp.MustCompile(`(?i)\b(any user|anyone|public(ly)?|no auth(entication)?|unauthenticated|without auth)\b`)
)

func checkLifecycleAdminOnly(file string, lines []string) {
	if strings.HasSuffix(file, ".json") {
		return
	}
	for i, line := range lines {
		for _, ep := range lifecycleEndpoints {
			if !strings.Contains(line, ep) {
				continue
			}
			if contradictions.MatchString(window(lines, i, 3, 3)) {
				fail(file, i+1, "lifecycle endpoint %s described as non-admin (contradicts admin-only policy)", ep)
			}
		}
	}
}

// 5. No retired tenant-admin APIs or stale token routes.
var staleClaims = []struct {
	re  *regexp.Regexp
	msg string
}{
	{regexp.MustCompile(`/v1/admin/tenants\b`), "retired tenant admin endpoint documented"},
	{regexp.MustCompile(`/v1/admin/decay/(run|config)\b`), "retired admin decay endpoint documented"},
	{regexp.MustCompile(`(?i)tenant_tokens|resolveTenantToken|Tenant tokens`), "stale tenant-token model documented"},
	{regexp.MustCompile(`/v1/me/tokens/<hash>/revoke|/v1/me/tokens/\{hash\}/revoke`), "stale token revoke route documented"},
	{regexp.MustCompile(`/api-docs/openapi\.json`), "raw OpenAPI URL is `/openapi.json`, not `/api-docs/openapi.json`"},
}

func checkNoStaleTenantAdminDocs(file string, lines []string) {
	for i, line := range lines {
		for _, s := range staleClaims {
			if s.re.MatchString(line) {
				fail(file, i+1, "%s", s.msg)
			}
		}
	}
}

// 6. Deployment templates must not make unsafe placeholders look applyable.
var (
	secretsEntry  = regexp.MustCompile(`^\s*-\s*secrets\.yaml\s*$`)
	unpinnedImage = regexp.MustCompile(`image:\s*falkordb/falkordb:(latest|edge)\b`)
)

func checkDeployFootguns(file string, lines []string) {
	switch file {
	case "deploy/k8s/kustomization.yaml":
		for _, l := range lines {
			if secretsEntry.MatchString(l) {
				fail(file, 0, "default kustomization must not apply placeholder secrets.yaml")
				return
			}
		}
	case "deploy/k8s/falkordb.yaml":
		for _, l := range lines {
			if unpinnedImage.MatchString(l) {
				fail(file, 0, "FalkorDB image must be pinned, not latest/edge")
				return
			}
		}
	}
}

// 7. No leftover `Co-Authored-By: Claude` trailers.
//
// Trailer-shaped lines only. Prose mentioning the trailer in backticks —
// the CHANGELOG entry recording its removal, CLAUDE.md forbidding it — is
// deliberately allowed.
var trailer = regexp.MustCompile(`^\s*Co-Authored-By:\s*Claude`)

func checkNoCoAuthoredByClaude(file string, lines []string) {
	// This checker names the trailer by necessity.
	if strings.HasSuffix(file, "cmd/doc-smoke/checks.go") {
		return
	}
	for i, line := range lines {
		if trailer.MatchString(line) {
			fail(file, i+1, "leftover `Co-Authored-By: Claude` trailer")
		}
	}
}

// 8. No leftover `P[0-9]-` review markers in docs.
var reviewMarker = regexp.MustCompile(`\bP[0-9]-[A-Za-z0-9_-]+`)

func checkNoReviewMarkers(file string, lines []string) {
	for i, line := range lines {
		if reviewMarker.MatchString(line) {
			fail(file, i+1, "leftover `P[0-9]-` review marker")
		}
	}
}

// 9. Every server endpoint a doc names must exist in the generated spec.
//
// The invariants above are each a reaction to one past drift, so they
// only catch drift somebody already predicted. This one is derived from
// the route table itself, so it catches endpoints renamed or removed in
// future without anyone adding a rule. Retroactively it is what would
// have caught `/api-docs` surviving the Fastify server's deletion (#264).
//
// Deliberately conservative: only code spans with this API's shape are
// judged. A noisy invariant gets switched off, which is worse than not
// having one.

// nonOperationPaths are served but deliberately not OpenAPI operations.
// Each entry states why, so this cannot quietly become a place to
// silence real failures.
var nonOperationPaths = map[string]string{
	"/openapi.json": "the spec does not describe itself",
	"/api-docs":     "the rendered view of the spec, not an operation in it",
	"/metrics":      "Prometheus exposition, not a JSON API operation",
	"/admin":        "dashboard SPA shell",
	"/favicon.ico":  "static asset",
	"/v1/rerank":    "upstream LiteLLM gateway route, not served by novamem",
	// Removed in ADR 0007 — the HTTP+SSE transport from revision
	// 2024-11-05. Docs may name these paths, but only to say they are
	// gone; a doc telling a reader to USE one is caught by review.
	"/mcp/sse":      "removed in ADR 0007; docs name it only to say so",
	"/mcp/messages": "removed in ADR 0007; docs name it only to say so",
}

// historicalDocs describe history or a past audit rather than today's
// server, and go stale on purpose.
var historicalDocs = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(^|/)CHANGELOG\.md$`),
	regexp.MustCompile(`(?i)(^|/)adr/`),
	regexp.MustCompile(`go-parity-audit\.md$`),
	regexp.MustCompile(`(^|/)superpowers/`),
}

var (
	codeSpan    = regexp.MustCompile("`([^`]+)`")
	pathSpan    = regexp.MustCompile(`^(?:(?:GET|PUT|POST|PATCH|DELETE)\s+)?(/[A-Za-z0-9._/{}-]*)$`)
	ourSurface  = regexp.MustCompile(`^/(v1|mcp|api-docs|health|live|ready)\b`)
	futureWork  = regexp.MustCompile(`(?i)\b(planned|proposed|not yet implemented|does not exist yet)\b`)
	specMatcher []*regexp.Regexp
)

func loadSpecMatchers() []*regexp.Regexp {
	if specMatcher != nil {
		return specMatcher
	}
	b, err := os.ReadFile(filepath.Join(root, "docs/api/openapi.json"))
	if err != nil {
		fail("docs/api/openapi.json", 1, "unreadable, so endpoints cannot be checked: %v", err)
		specMatcher = []*regexp.Regexp{}
		return specMatcher
	}
	var spec struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		fail("docs/api/openapi.json", 1, "unparseable: %v", err)
		specMatcher = []*regexp.Regexp{}
		return specMatcher
	}
	keys := make([]string, 0, len(spec.Paths))
	for p := range spec.Paths {
		keys = append(keys, p)
	}
	sort.Strings(keys)
	for _, p := range keys {
		segs := strings.Split(p, "/")
		for i, s := range segs {
			if strings.HasPrefix(s, "{") && strings.HasSuffix(s, "}") {
				segs[i] = "[^/]+"
			} else {
				segs[i] = regexp.QuoteMeta(s)
			}
		}
		specMatcher = append(specMatcher, regexp.MustCompile("^"+strings.Join(segs, "/")+"$"))
	}
	return specMatcher
}

func checkEndpointsExist(file string, lines []string) {
	for _, re := range historicalDocs {
		if re.MatchString(file) {
			return
		}
	}
	matchers := loadSpecMatchers()
	for i, line := range lines {
		for _, span := range codeSpan.FindAllStringSubmatch(line, -1) {
			m := pathSpan.FindStringSubmatch(strings.TrimSpace(span[1]))
			if m == nil {
				continue
			}
			p := m[1]
			// A trailing slash describes a family, not an endpoint.
			if strings.HasSuffix(p, "/") {
				continue
			}
			if _, ok := nonOperationPaths[p]; ok {
				continue
			}
			if !ourSurface.MatchString(p) {
				continue
			}
			if matchesSpec(matchers, p) {
				continue
			}
			// A route the docs present as future work is an honest
			// reference — but the marker has to be on the line, so it
			// cannot wave through a stale endpoint elsewhere.
			if futureWork.MatchString(line) {
				continue
			}
			fail(file, i+1, "documents endpoint %s, which is not in docs/api/openapi.json — "+
				"remove the claim, or add the route and regenerate the spec", p)
		}
	}
}

func matchesSpec(matchers []*regexp.Regexp, p string) bool {
	for _, re := range matchers {
		if re.MatchString(p) {
			return true
		}
	}
	return false
}
