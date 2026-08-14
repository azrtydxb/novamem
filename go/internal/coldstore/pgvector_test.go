package coldstore

import "testing"

// ScopeOf is the partition key AND the isolation rule — the tests in
// cold-store-pgvector.test.ts lock the same discipline TS-side.
func TestScopeOf(t *testing.T) {
	if got := ScopeOf("alice", nil); got != "u:alice" {
		t.Fatalf("user scope: %q", got)
	}
	p := "01PROJECT"
	if got := ScopeOf("alice", &p); got != "p:01PROJECT" {
		t.Fatalf("project scope: %q", got)
	}
}

func TestVectorLiteral(t *testing.T) {
	if got := VectorLiteral([]float64{1, 0.5, -0.25}); got != "[1,0.5,-0.25]" {
		t.Fatalf("literal: %q", got)
	}
	if got := VectorLiteral(nil); got != "[]" {
		t.Fatalf("empty: %q", got)
	}
}
