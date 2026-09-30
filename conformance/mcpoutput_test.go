package conformance

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// TestMCPToolResultsMatchOutputSchemas holds every tool's real answer to
// the outputSchema it advertises. A tool that declares one must return
// structuredContent, and a client validates that object against the
// schema: Claude Code drops the whole call when either fails ("has an
// output schema but did not return structured content"). Both failed for
// every tool from #284 until 2026-09-30 — the server sent text only, and
// the schemas said `nullable`, which JSON Schema does not have, so a null
// field failed its type.
//
// proved by: removing structuredContent from the server's tool result
// fails every exercised tool here; publishing a schema that still says
// `nullable` fails each tool whose answer carries a null.
func TestMCPToolResultsMatchOutputSchemas(t *testing.T) {
	Target(t)
	s := connect(t)
	defer s.disconnect(t)

	schemas := map[string]map[string]any{}
	listed := s.mustResult(t, "tools/list", map[string]any{})
	tools, _ := listed["tools"].([]any)
	for _, raw := range tools {
		tool, _ := raw.(map[string]any)
		name, _ := tool["name"].(string)
		if out, ok := tool["outputSchema"].(map[string]any); ok {
			schemas[name] = out
		}
	}
	if len(schemas) == 0 {
		t.Fatal("no tool advertises an outputSchema")
	}

	// Sharing needs a second account; everything else runs on this one.
	skipped := map[string]string{
		"project_share":   "needs a second user to share with",
		"project_unshare": "needs a second user to unshare",
	}
	exercised := map[string]bool{}
	check := func(name string, args map[string]any) map[string]any {
		t.Helper()
		exercised[name] = true
		res, rpcErr := s.callTool(t, name, args)
		if rpcErr != nil {
			t.Errorf("%s: JSON-RPC error %v", name, rpcErr)
			return nil
		}
		if isErr, _ := res["isError"].(bool); isErr {
			t.Errorf("%s: tool error %v", name, res["content"])
			return nil
		}
		sc, ok := res["structuredContent"].(map[string]any)
		if !ok {
			t.Errorf("%s: no structuredContent object (got %T) although the tool declares an outputSchema", name, res["structuredContent"])
			return toolJSON(t, res)
		}
		if text := toolJSON(t, res); !reflect.DeepEqual(text, sc) {
			t.Errorf("%s: structuredContent and text content disagree:\n %v\n %v", name, sc, text)
		}
		if schema, ok := schemas[name]; ok {
			if err := validateSchema(schema, sc, "$"); err != nil {
				t.Errorf("%s: structuredContent does not match its outputSchema: %v", name, err)
			}
		}
		return sc
	}

	shelf := NS()
	marker := "mcp output schema marker " + shelf

	check("memory_stats", map[string]any{})
	captured := check("memory_capture", map[string]any{"content": marker + " captured", "namespace": shelf, "force": true})
	remembered := check("memory_remember", map[string]any{"content": marker + " remembered", "namespace": shelf})
	check("memory_search", map[string]any{"query": marker, "namespace": shelf})
	check("memory_context", map[string]any{"message": marker, "namespace": shelf})
	check("memory_recent", map[string]any{"namespace": shelf})
	check("memory_today", map[string]any{})
	check("memory_session_recap", map[string]any{"namespace": shelf, "decisions": []any{marker + " decision"}})
	check("memory_hygiene", map[string]any{})
	check("memory_adoption", map[string]any{"client": "claude-code"})
	check("memory_evaluate", map[string]any{})
	check("project_list", map[string]any{})

	if id, _ := remembered["id"].(string); id != "" {
		check("memory_neighbors", map[string]any{"id": id})
		check("memory_update", map[string]any{"id": id, "content": marker + " updated"})
		check("memory_forget", map[string]any{"id": id})
	} else {
		t.Error("memory_remember returned no id: memory_neighbors, memory_update and memory_forget not exercised")
	}
	// Over MCP a capture answers in the session-recap shape: the id is in
	// its one result.
	if results, _ := captured["results"].([]any); len(results) == 1 {
		first, _ := results[0].(map[string]any)
		if id, _ := first["id"].(string); id != "" {
			if _, rpcErr := s.callTool(t, "memory_forget", map[string]any{"id": id}); rpcErr != nil {
				t.Errorf("cleanup: forget %s: %v", id, rpcErr)
			}
		} else {
			t.Errorf("memory_capture (force) saved nothing: %v", captured)
		}
	} else {
		t.Errorf("memory_capture: want one result, got %v", captured)
	}

	project := check("project_create", map[string]any{"name": "conf-mcp-output-" + shelf})
	if pid, _ := project["id"].(string); pid != "" {
		check("project_activate", map[string]any{"project": pid})
		check("project_deactivate", map[string]any{})
		check("project_delete", map[string]any{"project": pid})
	} else {
		t.Error("project_create returned no id: project_activate/deactivate/delete not exercised")
	}

	// Every advertised schema is either exercised or skipped by name: a
	// new tool cannot slip past this test by being forgotten.
	var missed []string
	for name := range schemas {
		if !exercised[name] && skipped[name] == "" {
			missed = append(missed, name)
		}
	}
	sort.Strings(missed)
	if len(missed) > 0 {
		t.Errorf("tools with an outputSchema this test does not exercise (add them, or skip one with a reason): %s", strings.Join(missed, ", "))
	}
	for name, why := range skipped {
		t.Logf("not exercised: %s (%s)", name, why)
	}
}

// validateSchema checks v against the JSON Schema subset the tool
// surface uses — type (a name or a list of names), enum, properties,
// required, items and additionalProperties — with JSON Schema's
// semantics: a keyword it does not define, such as OpenAPI's `nullable`,
// is ignored, exactly as an MCP client's validator ignores it.
func validateSchema(schema map[string]any, v any, path string) error {
	if types := schemaTypes(schema["type"]); len(types) > 0 {
		ok := false
		for _, typ := range types {
			if jsonType(typ, v) {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("%s: %s, want type %v", path, describe(v), schema["type"])
		}
	}
	if enum, ok := schema["enum"].([]any); ok {
		found := false
		for _, e := range enum {
			if reflect.DeepEqual(e, v) {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("%s: %s is not one of %v", path, describe(v), enum)
		}
	}
	switch vv := v.(type) {
	case map[string]any:
		props, _ := schema["properties"].(map[string]any)
		if req, ok := schema["required"].([]any); ok {
			for _, r := range req {
				if _, has := vv[r.(string)]; !has {
					return fmt.Errorf("%s.%s: required field missing", path, r)
				}
			}
		}
		keys := make([]string, 0, len(vv))
		for k := range vv {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if ps, ok := props[k].(map[string]any); ok {
				if err := validateSchema(ps, vv[k], path+"."+k); err != nil {
					return err
				}
				continue
			}
			switch extra := schema["additionalProperties"].(type) {
			case bool:
				if !extra {
					return fmt.Errorf("%s.%s: not allowed (additionalProperties: false)", path, k)
				}
			case map[string]any:
				if err := validateSchema(extra, vv[k], path+"."+k); err != nil {
					return err
				}
			}
		}
	case []any:
		if items, ok := schema["items"].(map[string]any); ok {
			for i, e := range vv {
				if err := validateSchema(items, e, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func schemaTypes(t any) []string {
	switch tt := t.(type) {
	case string:
		return []string{tt}
	case []any:
		out := make([]string, 0, len(tt))
		for _, e := range tt {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func jsonType(typ string, v any) bool {
	switch typ {
	case "null":
		return v == nil
	case "object":
		_, ok := v.(map[string]any)
		return ok
	case "array":
		_, ok := v.([]any)
		return ok
	case "string":
		_, ok := v.(string)
		return ok
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "number":
		_, ok := v.(float64)
		return ok
	case "integer":
		f, ok := v.(float64)
		return ok && f == float64(int64(f))
	}
	return false
}

func describe(v any) string {
	if v == nil {
		return "null"
	}
	b, _ := json.Marshal(v)
	if len(b) > 80 {
		b = append(b[:80], "…"...)
	}
	return fmt.Sprintf("%T %s", v, b)
}
