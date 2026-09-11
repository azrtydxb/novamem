package httpapi

import (
	"sort"
	"strings"
)

// undocumented reports patterns the mux serves that the contract
// deliberately does not describe: the dashboard SPA, non-API odds and
// ends, and Better Auth's whole surface — the document's `info` block
// points at Better Auth's own docs for those shapes. Anything else that
// is served without a table entry fails openapi_test.go.
func undocumented(pattern string) bool {
	switch pattern {
	case "GET /openapi.json", // the document doesn't describe itself
		"GET /api-docs", "GET /api-docs/{version}/standalone.js", // the rendered view of it, and its bundle
		"GET /favicon.ico",
		"GET /admin", "GET /admin/",
		"/": // 404 catch-all
		return true
	}
	_, path, ok := strings.Cut(pattern, " ")
	if !ok {
		path = pattern
	}
	return strings.HasPrefix(path, "/api/auth/")
}

// OpenAPIDocument is the contract — the same bytes /openapi.json
// serves, generated from api/openapi.yaml by cmd/gen-contract.
func OpenAPIDocument() []byte { return openapiDoc }

// documentedPatterns is the contract's own route list, generated from
// api/openapi.yaml. It is what openapi_test.go compares the mux against.
func documentedPatterns() map[string]bool {
	out := make(map[string]bool, len(generatedRoutes))
	for _, r := range generatedRoutes {
		out[r.Method+" "+r.Path] = true
	}
	return out
}

// sortedKeys is a test helper kept next to its data.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
