package novamem

// Route-coverage pin. The list of API routes, and which client method
// covers each, lives in ../contract/routes.json — one file shared by every
// novamem SDK (ADR 0009). clients/contract checks that list against the
// OpenAPI document; this test checks the half only Go can see: every
// method routes.json credits to Client, Management or Admin exists here.
//
// The list used to be a map in this file whose method names nothing
// checked, and for a while five rows credited Client with Management
// methods and one credited Management with a Today it did not have.

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// proved by: renaming Management.Decay to Client.Decay in routes.json
// fails this test.
func TestEveryRouteIsAccounted(t *testing.T) {
	raw, err := os.ReadFile("../contract/routes.json")
	if err != nil {
		t.Skipf("routes.json not readable outside the monorepo: %v", err)
	}
	var routes map[string]struct {
		Methods []struct {
			Name string `json:"name"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(raw, &routes); err != nil {
		t.Fatalf("parse routes.json: %v", err)
	}
	types := map[string]reflect.Type{
		"Client":     reflect.TypeFor[*Client](),
		"Management": reflect.TypeFor[*Management](),
		"Admin":      reflect.TypeFor[*Admin](),
	}
	methods := 0
	for key, r := range routes {
		for _, m := range r.Methods {
			methods++
			class, method, _ := strings.Cut(m.Name, ".")
			typ, ok := types[class]
			if !ok {
				t.Errorf("%s: unknown class %q", key, class)
				continue
			}
			if _, ok := typ.MethodByName(method); !ok {
				t.Errorf("%s: %s has no method %s", key, class, method)
			}
		}
	}
	if methods == 0 {
		t.Fatal("routes.json names no methods — wrong file?")
	}
}
