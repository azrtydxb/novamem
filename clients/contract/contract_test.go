package contract

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func loadSpec(t *testing.T) (paths map[string]map[string]json.RawMessage, schemas map[string]json.RawMessage) {
	t.Helper()
	raw, err := os.ReadFile("../../docs/api/openapi.json")
	if err != nil {
		t.Fatalf("read openapi.json: %v", err)
	}
	var doc struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse openapi.json: %v", err)
	}
	return doc.Paths, doc.Components.Schemas
}

// proved by: deleting any route's entry from routes.json, or adding a
// path to api/openapi.yaml, fails this test.
func TestRoutesJSONCoversOpenAPI(t *testing.T) {
	routes, err := LoadRoutes("routes.json")
	if err != nil {
		t.Fatal(err)
	}
	paths, _ := loadSpec(t)
	seen := map[string]bool{}
	for p, ops := range paths {
		for m := range ops {
			switch m {
			case "get", "post", "put", "delete", "patch":
				key := strings.ToUpper(m) + " " + p
				seen[key] = true
				if _, ok := routes[key]; !ok {
					t.Errorf("%s is in openapi.json but not in routes.json — map it to SDK methods or record it as a nonGoal", key)
				}
			}
		}
	}
	for key := range routes {
		if !seen[key] {
			t.Errorf("routes.json entry %s no longer exists in openapi.json", key)
		}
	}
}

// proved by: removing the RevokeResult schema from api/openapi.yaml
// fails this test.
func TestWrappedRoutesDeclareResponseSchema(t *testing.T) {
	routes, err := LoadRoutes("routes.json")
	if err != nil {
		t.Fatal(err)
	}
	_, schemas := loadSpec(t)
	for key, r := range routes {
		for _, m := range r.Methods {
			if m.Response == nil {
				continue
			}
			if _, ok := schemas[*m.Response]; !ok {
				t.Errorf("%s (%s): response schema %q missing from openapi.json", key, m.Name, *m.Response)
			}
		}
	}
}

// proved by: deleting any one method from routes.json fails this test.
func TestSurfaceIsFortyOneMethods(t *testing.T) {
	routes, err := LoadRoutes("routes.json")
	if err != nil {
		t.Fatal(err)
	}
	if got := len(Surface(routes)); got != 41 {
		t.Fatalf("surface = %d methods, want 41", got)
	}
}

func TestLoadRoutesRejectsAmbiguousEntries(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"both":    `{"GET /x": {"methods": [{"name": "Client.X", "op": "x", "response": null}], "nonGoal": "why"}}`,
		"neither": `{"GET /x": {}}`,
	} {
		p := dir + "/" + name + ".json"
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadRoutes(p); err == nil || !strings.Contains(err.Error(), "GET /x") {
			t.Errorf("%s: err = %v, want one naming GET /x", name, err)
		}
	}
}
