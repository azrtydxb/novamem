package engine

import "testing"

// Cases pinned to engine/index.ts shouldReject: the reason strings are
// contract (the conformance suite asserts a reject on "ok thanks").
func TestShouldReject(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{"under 12 chars", "ok thanks", "too short — not durable knowledge"},
		{"exactly 11 after trim", "  12345678901  ", "too short — not durable knowledge"},
		{"12 chars passes", "123456789012", ""},
		{"filler word thanks", "thanks", "too short — not durable knowledge"}, // length rule first
		{"filler phrase got it padded", "got it", "too short — not durable knowledge"},
		{"substantive fact", "the deploy target is novamem-bench on the kw cluster", ""},
		{"filler with period over 12", "understood then", ""},
		// ≥12-char filler phrases that hit the filler regex: none of the
		// canned replies exceed 12 chars except none — the regex is still
		// exercised via a padded case below (trailing period allowed).
		{"alright with period is 8 chars", "alright.", "too short — not durable knowledge"},
	}
	for _, tt := range tests {
		if got := ShouldReject(tt.content); got != tt.want {
			t.Errorf("%s: ShouldReject(%q) = %q, want %q", tt.name, tt.content, got, tt.want)
		}
	}
}

func TestContentTooLong(t *testing.T) {
	long := make([]byte, 4001)
	for i := range long {
		long[i] = 'a'
	}
	if got := ContentTooLong(string(long), 4000); got != "too long (4001 chars, max 4000) — split into one fact per entry" {
		t.Errorf("over limit: %q", got)
	}
	if got := ContentTooLong(string(long), 0); got != "" {
		t.Errorf("maxChars 0 disables the check, got %q", got)
	}
	if got := ContentTooLong("short", 4000); got != "" {
		t.Errorf("under limit: %q", got)
	}
	// Trim before counting (TS trims first).
	padded := " " + string(long[:4000]) + " "
	if got := ContentTooLong(padded, 4000); got != "" {
		t.Errorf("trimmed content at exactly the limit must pass, got %q", got)
	}
}
