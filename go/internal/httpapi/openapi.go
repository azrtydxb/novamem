package httpapi

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
)

// apiRoute is one documented operation: what the mux serves plus the
// metadata OpenAPI needs. The table lives in openapi_routes.go and is
// cross-checked against the mux by openapi_test.go, so the document can
// only describe routes this server actually registers.
type apiRoute struct {
	Method      string
	Path        string
	Summary     string
	Description string
	Tags        []string
	// Security lists security-scheme names, in the order the TS server
	// declared them (the document is order-sensitive byte-wise).
	Security []string
	// Body is the raw JSON Schema of the application/json request body
	// ("" = no body). Params is a raw OpenAPI `parameters` array.
	// Responses defaults to Fastify's `{"200":{"description":"Default
	// Response"}}` when empty.
	Body      string
	Params    string
	Responses string
}

const defaultResponses = `{"200":{"description":"Default Response"}}`

// undocumented reports patterns the mux serves that the contract
// deliberately does not describe: the dashboard SPA, non-API odds and
// ends, and Better Auth's whole surface — the document's `info` block
// points at Better Auth's own docs for those shapes. Anything else that
// is served without a table entry fails openapi_test.go.
func undocumented(pattern string) bool {
	switch pattern {
	case "GET /openapi.json", // the document doesn't describe itself
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

// OpenAPIDocument is the rendered contract — the same bytes
// /openapi.json serves. cmd/gen-openapi writes it to docs/api.
func OpenAPIDocument() []byte { return openapiDoc }

// buildOpenAPI renders the contract document. Byte-stable: fragments are
// spliced in verbatim and the whole thing is indented once at the end,
// so the CI drift gate compares content, not formatting.
func buildOpenAPI() []byte {
	var b bytes.Buffer
	b.WriteString(`{"openapi":`)
	writeJSONString(&b, openapiVersion)
	b.WriteString(`,"info":`)
	b.WriteString(openapiInfo)
	b.WriteString(`,"components":`)
	b.WriteString(openapiComponents)
	b.WriteString(`,"paths":{`)

	// Group by path, preserving the table's order in both dimensions.
	var order []string
	byPath := map[string][]apiRoute{}
	for _, r := range apiRoutes {
		if _, seen := byPath[r.Path]; !seen {
			order = append(order, r.Path)
		}
		byPath[r.Path] = append(byPath[r.Path], r)
	}
	for i, p := range order {
		if i > 0 {
			b.WriteByte(',')
		}
		writeJSONString(&b, p)
		b.WriteString(`:{`)
		for j, r := range byPath[p] {
			if j > 0 {
				b.WriteByte(',')
			}
			writeJSONString(&b, strings.ToLower(r.Method))
			b.WriteByte(':')
			writeOperation(&b, r)
		}
		b.WriteByte('}')
	}

	b.WriteString(`},"servers":`)
	b.WriteString(openapiServers)
	b.WriteString(`,"tags":`)
	b.WriteString(openapiTags)
	b.WriteByte('}')

	var out bytes.Buffer
	if err := json.Indent(&out, b.Bytes(), "", "  "); err != nil {
		// Only reachable if a hand-edited fragment isn't valid JSON;
		// openapi_test.go catches that before it ships.
		panic("openapi: invalid fragment: " + err.Error())
	}
	out.WriteByte('\n')
	return out.Bytes()
}

func writeOperation(b *bytes.Buffer, r apiRoute) {
	b.WriteString(`{"summary":`)
	writeJSONString(b, r.Summary)
	b.WriteString(`,"tags":[`)
	for i, t := range r.Tags {
		if i > 0 {
			b.WriteByte(',')
		}
		writeJSONString(b, t)
	}
	b.WriteByte(']')
	if r.Description != "" {
		b.WriteString(`,"description":`)
		writeJSONString(b, r.Description)
	}
	if r.Body != "" {
		b.WriteString(`,"requestBody":{"required":true,"content":{"application/json":{"schema":`)
		b.WriteString(r.Body)
		b.WriteString(`}}}`)
	}
	if r.Params != "" {
		b.WriteString(`,"parameters":`)
		b.WriteString(r.Params)
	}
	if len(r.Security) > 0 {
		b.WriteString(`,"security":[`)
		for i, s := range r.Security {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteByte('{')
			writeJSONString(b, s)
			b.WriteString(`:[]}`)
		}
		b.WriteByte(']')
	}
	b.WriteString(`,"responses":`)
	if r.Responses != "" {
		b.WriteString(r.Responses)
	} else {
		b.WriteString(defaultResponses)
	}
	b.WriteByte('}')
}

// writeJSONString escapes like JSON.stringify (no HTML escaping), which
// is what the document was originally written with.
func writeJSONString(b *bytes.Buffer, s string) {
	enc, err := marshalJS(s)
	if err != nil {
		panic(err)
	}
	b.Write(enc)
}

// documentedPatterns is the mux-pattern form of the route table, used by
// the registration cross-check.
func documentedPatterns() map[string]bool {
	out := make(map[string]bool, len(apiRoutes))
	for _, r := range apiRoutes {
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
