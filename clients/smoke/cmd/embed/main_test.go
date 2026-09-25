package main

import (
	"math"
	"testing"
)

// proved by: seeding the hash per call (or dropping the normalisation)
// fails this test.
func TestEmbedIsDeterministicAndUnit(t *testing.T) {
	a, b := Embed("sdk-smoke go 1234abcd", 384), Embed("sdk-smoke go 1234abcd", 384)
	var norm, dot float64
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("component %d differs between identical inputs", i)
		}
		norm += a[i] * a[i]
		dot += a[i] * Embed("1234abcd", 384)[i]
	}
	if math.Abs(norm-1) > 1e-9 {
		t.Fatalf("norm = %v, want 1", norm)
	}
	if dot <= 0 {
		t.Fatalf("a text and one of its words do not overlap (dot %v)", dot)
	}
	if e := Embed("", 8); e[0] != 1 {
		t.Fatalf("empty text = %v, want a unit vector on bucket 0", e)
	}
}
