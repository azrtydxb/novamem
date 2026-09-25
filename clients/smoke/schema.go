// Package smoke checks live server responses against docs/api/openapi.json,
// for the sdk-smoke CI job. The SDKs' types are generated from that
// document; a handler that drifts from it breaks every SDK at once.
package smoke

import (
	"fmt"
	"sort"
	"strings"
)

// Validate checks v (decoded JSON) against the named component schema of
// doc. It covers the subset the novamem spec uses: type, required,
// properties (recursively), items, nullable and $ref. Unknown fields pass.
// The error names the JSON path of the first mismatch.
func Validate(doc map[string]any, schemaName string, v any) error {
	s, err := component(doc, schemaName)
	if err != nil {
		return err
	}
	return validate(doc, s, v, "$")
}

func component(doc map[string]any, name string) (map[string]any, error) {
	comps, _ := doc["components"].(map[string]any)
	schemas, _ := comps["schemas"].(map[string]any)
	s, ok := schemas[name].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("no component schema %q", name)
	}
	return s, nil
}

func validate(doc, s map[string]any, v any, path string) error {
	if ref, ok := s["$ref"].(string); ok {
		r, err := component(doc, strings.TrimPrefix(ref, "#/components/schemas/"))
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		return validate(doc, r, v, path)
	}
	if v == nil {
		if nullable, _ := s["nullable"].(bool); nullable {
			return nil
		}
		if _, typed := s["type"]; !typed {
			return nil
		}
		return fmt.Errorf("%s: null, want %v", path, s["type"])
	}
	switch t, _ := s["type"].(string); t {
	case "object":
		m, ok := v.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: %T, want object", path, v)
		}
		// Fields that are present are checked first, in name order, so the
		// first error reported does not depend on map iteration.
		props, _ := s["properties"].(map[string]any)
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			ps, ok := props[k].(map[string]any)
			if !ok {
				continue // unknown fields pass
			}
			if err := validate(doc, ps, m[k], path+"."+k); err != nil {
				return err
			}
		}
		req, _ := s["required"].([]any)
		for _, r := range req {
			if _, ok := m[r.(string)]; !ok {
				return fmt.Errorf("%s.%s: required field missing", path, r)
			}
		}
	case "array":
		a, ok := v.([]any)
		if !ok {
			return fmt.Errorf("%s: %T, want array", path, v)
		}
		if items, ok := s["items"].(map[string]any); ok {
			for i, x := range a {
				if err := validate(doc, items, x, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
	case "string":
		if _, ok := v.(string); !ok {
			return fmt.Errorf("%s: %T, want string", path, v)
		}
	case "integer":
		f, ok := v.(float64)
		if !ok || f != float64(int64(f)) {
			return fmt.Errorf("%s: %v, want integer", path, v)
		}
	case "number":
		if _, ok := v.(float64); !ok {
			return fmt.Errorf("%s: %T, want number", path, v)
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("%s: %T, want boolean", path, v)
		}
	}
	return nil
}
