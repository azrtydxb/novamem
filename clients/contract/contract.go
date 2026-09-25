// Package contract loads the language-neutral truth every novamem SDK is
// held to (ADR 0009).
//
// routes.json is the one list of API routes and, for each, either the SDK
// methods that cover it or the reason none does. Each SDK's route test
// reads it, which is what makes "a new route fails every SDK until each
// makes a decision" true without nine hand-kept copies of the list.
package contract

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// Method is one SDK method, named as "<Class>.<Method>" in Go's casing;
// each SDK derives its own casing from it.
type Method struct {
	Name string `json:"name"`
	// Op is the error-classification label the Go client uses for this
	// method ("search", "remove-member", …). Every SDK reports the same one.
	Op string `json:"op"`
	// Params are the scalar arguments, in order. Their names are argument
	// names, not wire names: AddProjectMember's email travels in a body
	// field called "username", and Update's id travels in the path.
	Params []Param `json:"params,omitempty"`
	// Request names the generated request type, for methods that take one.
	// A method may take both: Update(id, request).
	Request string `json:"request,omitempty"`
	// Response names a schema in the OpenAPI components section, or is nil
	// for routes that answer with no payload.
	Response *string `json:"response"`
}

// Param is one scalar argument. Statically typed SDKs build their
// signatures from Type and Required.
type Param struct {
	Name string `json:"name"`
	// Type is string, int32, int64, bool, or object[] (a list of
	// free-form JSON objects, as Import takes).
	Type string `json:"type"`
	// Required arguments are validated locally; optional ones are left
	// out of the request when unset.
	Required bool `json:"required"`
}

// Route is one "METHOD /path" entry: covered by Methods, or a NonGoal.
type Route struct {
	Methods []Method `json:"methods,omitempty"`
	NonGoal string   `json:"nonGoal,omitempty"`
}

// LoadRoutes reads routes.json. An entry that is both covered and a
// non-goal, or neither, is an error: either reading would be a guess.
func LoadRoutes(path string) (map[string]Route, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var routes map[string]Route
	if err := json.Unmarshal(raw, &routes); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	for key, r := range routes {
		for _, m := range r.Methods {
			for _, p := range m.Params {
				switch p.Type {
				case "string", "int32", "int64", "bool", "object[]":
				default:
					return nil, fmt.Errorf("%s %s: param %q has unknown type %q", key, m.Name, p.Name, p.Type)
				}
			}
		}
		switch {
		case len(r.Methods) > 0 && r.NonGoal != "":
			return nil, fmt.Errorf("%s: has both methods and a nonGoal", key)
		case len(r.Methods) == 0 && r.NonGoal == "":
			return nil, fmt.Errorf("%s: has neither methods nor a nonGoal", key)
		}
	}
	return routes, nil
}

// Surface is every SDK method across all routes, sorted by name.
func Surface(routes map[string]Route) []Method {
	var out []Method
	for _, r := range routes {
		out = append(out, r.Methods...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
