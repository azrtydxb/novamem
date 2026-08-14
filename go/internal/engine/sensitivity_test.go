package engine

import (
	"testing"
	"time"
)

// Pinned to engine/index.ts inferSensitivity: explicit > metadata >
// content sniff > "private".
func TestInferSensitivity(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		metadata map[string]any
		explicit string
		want     string
	}{
		{"explicit wins", "my api key is sk-abcdefgh1234", nil, "public", "public"},
		{"metadata second", "plain text", map[string]any{"sensitivity": "internal"}, "", "internal"},
		{"invalid explicit falls through", "plain text", nil, "topsecret", "private"},
		{"api key sniff", "the api key lives in vault", nil, "", "sensitive"},
		{"api-key hyphen", "rotate the api-key monthly", nil, "", "sensitive"},
		{"token word", "the token expired", nil, "", "sensitive"},
		{"password word", "Password rotation policy", nil, "", "sensitive"},
		{"private key", "ssh private key on disk", nil, "", "sensitive"},
		{"private_key underscore", "the private_key file", nil, "", "sensitive"},
		{"sk- prefix", "use sk-abcdefgh_123 for tests", nil, "", "sensitive"},
		{"sk- too short not matched", "task sk-abc done", nil, "", "private"},
		{"plain content", "prefers dark roast coffee", nil, "", "private"},
	}
	for _, tt := range tests {
		if got := InferSensitivity(tt.content, tt.metadata, tt.explicit); got != tt.want {
			t.Errorf("%s: got %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestIsSensitivityVisible(t *testing.T) {
	meta := func(s string) map[string]any { return map[string]any{"sensitivity": s} }
	tests := []struct {
		name string
		md   map[string]any
		max  string
		want bool
	}{
		{"default max is private, private visible", meta("private"), "", true},
		{"default max hides sensitive", meta("sensitive"), "", false},
		{"explicit max sensitive shows all", meta("sensitive"), "sensitive", true},
		{"max public hides internal", meta("internal"), "public", false},
		{"missing metadata treated private", nil, "", true},
		{"missing metadata hidden at max public", nil, "public", false},
	}
	for _, tt := range tests {
		if got := isSensitivityVisible(tt.md, tt.max); got != tt.want {
			t.Errorf("%s: got %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestIsInactiveMemory(t *testing.T) {
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	tests := []struct {
		name string
		md   map[string]any
		want bool
	}{
		{"nil metadata active", nil, false},
		{"superseded hidden", map[string]any{"lifecycleStatus": "superseded"}, true},
		{"deprecated hidden", map[string]any{"lifecycleStatus": "deprecated"}, true},
		{"active status fine", map[string]any{"lifecycleStatus": "active"}, false},
		{"fact_inactive true hidden", map[string]any{"fact_inactive": true}, true},
		{"fact_inactive false fine", map[string]any{"fact_inactive": false}, false},
		{"expired TTL hidden", map[string]any{"expiresAt": past}, true},
		{"future TTL visible", map[string]any{"expiresAt": future}, false},
		{"unparseable TTL visible", map[string]any{"expiresAt": "not-a-date"}, false},
	}
	for _, tt := range tests {
		if got := isInactiveMemory(tt.md); got != tt.want {
			t.Errorf("%s: got %v, want %v", tt.name, got, tt.want)
		}
	}
}
