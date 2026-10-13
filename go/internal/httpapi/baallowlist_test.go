package httpapi

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestBAAllowlistMatchesOpenAPIAnnotations(t *testing.T) {
	raw, err := os.ReadFile("../../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}

	annotated := make(map[string]bool)
	for path, item := range doc.Paths {
		value, marked := item["x-ba-allow"]
		if strings.HasPrefix(path, "/api/auth/admin/") && !marked {
			t.Errorf("admin auth path %q is missing x-ba-allow", path)
		}
		if !marked {
			continue
		}
		allow, ok := value.(bool)
		if !ok || !allow {
			t.Errorf("%s has invalid x-ba-allow value %v", path, value)
			continue
		}
		annotated[path] = true
	}

	if len(annotated) != len(baAllowlist) {
		t.Fatalf("OpenAPI annotations have %d paths; generated baAllowlist has %d", len(annotated), len(baAllowlist))
	}
	for path := range annotated {
		if !baAllowlist[path] {
			t.Errorf("OpenAPI path %q is absent from generated baAllowlist", path)
		}
	}
	for path := range baAllowlist {
		if !annotated[path] {
			t.Errorf("generated baAllowlist path %q has no x-ba-allow annotation", path)
		}
	}
}
