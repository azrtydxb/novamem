package conformance

// Port of suites/00-meta.test.ts.

import (
	"fmt"
	"strings"
	"testing"
)

func TestMetaEndpointsAre200WithoutAuth(t *testing.T) {
	Target(t)
	for _, path := range []string{"/health", "/live", "/ready"} {
		t.Run(fmt.Sprintf("GET %s is 200 without auth", path), func(t *testing.T) {
			r := API(t, path, Opts{Token: NoAuth})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
		})
	}
}

func TestOpenAPIDocumentIsValid(t *testing.T) {
	Target(t)
	r := API(t, "/openapi.json", Opts{Token: NoAuth})
	if r.Status != 200 {
		t.Fatalf("status = %d, want 200", r.Status)
	}
	body := r.MustValidate(t, Schema{"openapi": Str, "paths": MapOf(Any)})
	if v, _ := body["openapi"].(string); !strings.HasPrefix(v, "3.") {
		t.Fatalf("openapi = %q, want 3.x", body["openapi"])
	}
	if paths := body["paths"].(map[string]any); len(paths) <= 20 {
		t.Fatalf("only %d paths", len(paths))
	}
}

func TestEveryLiveEndpointIsClaimedBySuite(t *testing.T) {
	Target(t)
	r := API(t, "/openapi.json", Opts{Token: NoAuth})
	paths := r.Obj(t)["paths"].(map[string]any)
	var unclaimed []string
	for p, methodsAny := range paths {
		for m := range methodsAny.(map[string]any) {
			key := strings.ToUpper(m) + " " + p
			if _, ok := Coverage[key]; ok {
				continue
			}
			if _, ok := Exempt[key]; ok {
				continue
			}
			unclaimed = append(unclaimed, key)
		}
	}
	if len(unclaimed) > 0 {
		t.Fatalf("unclaimed endpoints:\n%s", strings.Join(unclaimed, "\n"))
	}
}
