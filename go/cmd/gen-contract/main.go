// gen-contract renders every contract artifact from one authored
// source: api/openapi.yaml.
//
// The direction used to run the other way. The route table lived in Go
// as `apiRoutes` with schema fragments embedded as raw JSON strings, the
// MCP tool surface lived in tooldefs.json, and docs/api/openapi.json was
// generated from the first of those. Three places held pieces of one
// contract, and keeping them in agreement was a matter of tests and
// diligence.
//
// Now the spec is the source and everything else is output:
//
//	api/openapi.yaml
//	  ├── docs/api/openapi.json          the served + published document
//	  ├── go/internal/mcp/tooldefs.json  the MCP tool surface
//	  └── go/internal/httpapi/routes_gen.go  the route list the mux is checked against
//
// An operation that backs an MCP tool carries `x-mcp-tool` with the
// tool's name, description and inputSchema. That is the binding: there
// is no separate tool file to keep in step, and a tool cannot exist
// without an operation to serve it.
//
// Run it, commit the output; CI regenerates and fails on a dirty tree.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	specPath    = "../api/openapi.yaml"
	docJSONPath = "../docs/api/openapi.json"
	// The same bytes, inside the module, because go:embed cannot reach
	// outside it. This file used to exist untracked-by-anything and drift
	// (#263); now it is the served document and has a generator.
	embedJSONPath = "internal/httpapi/openapi.json"
	toolDefsPath  = "internal/mcp/tooldefs.json"
	routesGoPath  = "internal/httpapi/routes_gen.go"
)

// A tool definition is passed through whole rather than parsed into a
// struct. `annotations` (readOnlyHint, idempotentHint, title,
// openWorldHint) are part of the wire contract, and a struct modelling
// only the fields this generator happens to know about would drop
// anything the MCP spec adds later — silently, which is the failure this
// whole change exists to remove. Only the required keys are checked.
type mcpTool map[string]any

func (t mcpTool) name() string {
	s, _ := t["name"].(string)
	return s
}

// order is the tool's position in `tools/list`, declared in the source.
func (t mcpTool) order() int {
	f, _ := t["x-order"].(float64)
	return int(f)
}

func main() {
	raw, err := os.ReadFile(specPath)
	if err != nil {
		fail("reading %s: %v", specPath, err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		fail("parsing %s: %v", specPath, err)
	}

	paths, _ := doc["paths"].(map[string]any)
	if len(paths) == 0 {
		fail("%s declares no paths", specPath)
	}

	tools, routes := collect(paths, doc)
	if len(tools) == 0 {
		fail("%s binds no MCP tools — every tool is an operation carrying x-mcp-tool", specPath)
	}

	served := stripExtensions(doc)
	writeJSON(docJSONPath, served)
	writeJSON(embedJSONPath, served)
	// x-order places the tool; it is not part of the tool definition the
	// server sends.
	for _, t := range tools {
		delete(t, "x-order")
	}
	writeJSON(toolDefsPath, tools)
	writeRoutes(routesGoPath, routes)

	fmt.Printf("wrote %s, %s, %s and %s (%d operations, %d tools)\n",
		docJSONPath, embedJSONPath, toolDefsPath, routesGoPath, len(routes), len(tools))
}

type route struct {
	Method, Path, OperationID string
	Tool                      string
}

// collect walks the spec once, pulling out the tool surface and the
// route list in declaration-independent (sorted) order so the output is
// byte-stable.
// responseSchema pulls an operation's 200 application/json schema and
// resolves a top-level $ref against components, because an MCP client
// reads inputSchema/outputSchema as standalone JSON Schema and has no
// document to resolve a local pointer inside.
func responseSchema(op, doc map[string]any) map[string]any {
	resp, _ := op["responses"].(map[string]any)
	ok200, _ := resp["200"].(map[string]any)
	content, _ := ok200["content"].(map[string]any)
	appjson, _ := content["application/json"].(map[string]any)
	schema, _ := appjson["schema"].(map[string]any)
	if schema == nil {
		return nil
	}
	return resolve(schema, doc, 0)
}

// resolve inlines local $refs. Depth-bounded: a schema that refers to
// itself would otherwise expand forever, and a cycle is a real thing to
// write by accident.
func resolve(node any, doc map[string]any, depth int) map[string]any {
	if depth > 8 {
		fail("schema $ref nesting deeper than 8 — is there a cycle?")
	}
	m, ok := node.(map[string]any)
	if !ok {
		return nil
	}
	if ref, isRef := m["$ref"].(string); isRef {
		const prefix = "#/components/schemas/"
		if !strings.HasPrefix(ref, prefix) {
			fail("unsupported $ref %q — only local component schemas resolve", ref)
		}
		comps, _ := doc["components"].(map[string]any)
		schemas, _ := comps["schemas"].(map[string]any)
		target, found := schemas[strings.TrimPrefix(ref, prefix)]
		if !found {
			fail("$ref %q points at a schema that does not exist", ref)
		}
		return resolve(target, doc, depth+1)
	}
	out := map[string]any{}
	for k, v := range m {
		switch vv := v.(type) {
		case map[string]any:
			out[k] = resolve(vv, doc, depth+1)
		case []any:
			list := make([]any, 0, len(vv))
			for _, e := range vv {
				if em, isMap := e.(map[string]any); isMap {
					list = append(list, resolve(em, doc, depth+1))
				} else {
					list = append(list, e)
				}
			}
			out[k] = list
		default:
			out[k] = v
		}
	}
	return out
}

func collect(paths, doc map[string]any) ([]mcpTool, []route) {
	var tools []mcpTool
	var routes []route

	for _, p := range sortedKeys(paths) {
		item, _ := paths[p].(map[string]any)
		for _, m := range sortedKeys(item) {
			if !isMethod(m) {
				continue
			}
			op, _ := item[m].(map[string]any)
			id, _ := op["operationId"].(string)
			if id == "" {
				fail("%s %s has no operationId — every operation needs a stable name", strings.ToUpper(m), p)
			}
			r := route{Method: strings.ToUpper(m), Path: p, OperationID: id}

			if x, ok := op["x-mcp-tool"]; ok {
				t := toTool(x, m, p)
				r.Tool = t.name()
				// The tool's outputSchema is the operation's own 200
				// response, resolved. Authored once, in the place the HTTP
				// contract already needed it — so a tool cannot describe a
				// result shape its route does not return, and adding a
				// response type gives the MCP surface one for free.
				if out := responseSchema(op, doc); out != nil {
					t["outputSchema"] = out
				}
				// An operation that backs a tool gets the tool's own
				// description unless it has written its own. The tool text
				// is the richest thing anyone wrote about what this
				// operation does and when to reach for it; leaving the
				// HTTP reader with only a one-line summary while agents
				// get a paragraph is an arbitrary difference, and copying
				// it by hand would be a second copy to keep in step.
				if _, has := op["description"]; !has {
					if d, ok := t["description"].(string); ok {
						op["description"] = d
					}
				}
				tools = append(tools, t)
			}
			routes = append(routes, r)
		}
	}
	// `tools/list` order is part of what clients see. The spec says
	// servers SHOULD return tools deterministically, because clients cache
	// the list and models prompt-cache it — so the order is declared in
	// the source (`x-order`) rather than falling out of however the paths
	// happen to sort. Deriving it from path order would have silently
	// reshuffled the surface the day the contract moved into YAML.
	sort.Slice(tools, func(i, j int) bool { return tools[i].order() < tools[j].order() })
	seenOrder := map[int]string{}
	seenName := map[string]bool{}
	for _, t := range tools {
		if prev, dup := seenOrder[t.order()]; dup {
			fail("tools %q and %q both declare x-order %d", prev, t.name(), t.order())
		}
		seenOrder[t.order()] = t.name()
		// Two bindings with the same name would put a duplicate entry in
		// tools/list while the server's own name index collapsed them —
		// one of the two tools would be advertised and unreachable.
		if seenName[t.name()] {
			fail("tool %q is bound by more than one operation", t.name())
		}
		seenName[t.name()] = true
	}
	return tools, routes
}

func toTool(x any, method, path string) mcpTool {
	b, err := json.Marshal(x)
	if err != nil {
		fail("%s %s: x-mcp-tool is not encodable: %v", strings.ToUpper(method), path, err)
	}
	var t mcpTool
	if err := json.Unmarshal(b, &t); err != nil {
		fail("%s %s: x-mcp-tool is malformed: %v", strings.ToUpper(method), path, err)
	}
	where := strings.ToUpper(method) + " " + path
	if t.name() == "" {
		fail("%s: x-mcp-tool has no name", where)
	}
	if s, _ := t["description"].(string); s == "" {
		fail("%s: tool %q has no description — it is what an agent reads to decide to call it",
			where, t.name())
	}
	if _, ok := t["inputSchema"].(map[string]any); !ok {
		fail("%s: tool %q has no inputSchema object", where, t.name())
	}
	if _, ok := t["x-order"].(float64); !ok {
		fail("%s: tool %q has no x-order — tools/list order is part of the contract", where, t.name())
	}
	return t
}

// stripExtensions removes `x-mcp-tool` from the published document. The
// binding is real and belongs in the source; the served spec describes
// the HTTP surface, and repeating the whole tool surface inside it would
// double every schema on the wire.
func stripExtensions(doc map[string]any) map[string]any {
	paths, _ := doc["paths"].(map[string]any)
	for _, p := range sortedKeys(paths) {
		item, _ := paths[p].(map[string]any)
		for _, m := range sortedKeys(item) {
			if op, ok := item[m].(map[string]any); ok {
				delete(op, "x-mcp-tool")
			}
		}
	}
	return doc
}

func writeRoutes(path string, routes []route) {
	var b bytes.Buffer
	b.WriteString(`// Code generated by cmd/gen-contract from api/openapi.yaml. DO NOT EDIT.

package httpapi

// GeneratedRoute is one operation the contract declares. openapi_test.go
// checks this list against what the mux actually serves, in both
// directions: a route served but not in the spec is undocumented, and a
// route in the spec but not served is a promise nothing keeps.
type GeneratedRoute struct {
	Method      string
	Path        string
	OperationID string
	// Tool is the MCP tool this operation backs, or "" when it is
	// HTTP-only.
	Tool string
}

var generatedRoutes = []GeneratedRoute{
`)
	for _, r := range routes {
		fmt.Fprintf(&b, "\t{Method: %q, Path: %q, OperationID: %q, Tool: %q},\n",
			r.Method, r.Path, r.OperationID, r.Tool)
	}
	b.WriteString("}\n")
	if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
		fail("writing %s: %v", path, err)
	}
}

func writeJSON(path string, v any) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fail("encoding %s: %v", path, err)
	}
	if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
		fail("writing %s: %v", path, err)
	}
}

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func isMethod(s string) bool {
	switch s {
	case "get", "post", "put", "delete", "patch":
		return true
	}
	return false
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "gen-contract: "+format+"\n", a...)
	os.Exit(1)
}
