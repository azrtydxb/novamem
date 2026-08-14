// Worthiness gate. Transcribed from engine/index.ts shouldReject +
// contentTooLong. The reason strings are contract — the conformance
// suite and integrations read them.
package engine

import (
	"fmt"
	"regexp"
	"strings"
)

var fillerRe = regexp.MustCompile(`(?i)^(thanks?|ok(ay)?|sure|got it|great|cool|yes|no|nope|yep|alright|noted|done)\.?$`)

// ShouldReject returns "" when the content is fit to store, or the
// rejection reason. Callers honour force=true to bypass. Exact-duplicate
// detection happens separately via content hash.
func ShouldReject(content string) string {
	trimmed := strings.TrimSpace(content)
	// JS trims and counts UTF-16 units; below 12 of them the content is
	// not durable knowledge. utf16Len keeps parity for non-ASCII input.
	if utf16Len(trimmed) < 12 {
		return "too short — not durable knowledge"
	}
	if fillerRe.MatchString(trimmed) {
		return "conversational filler — not durable knowledge"
	}
	return ""
}

// ContentTooLong applies even under force (engine/index.ts
// contentTooLong): force skips the worthiness heuristics, not the
// embedder's length policy. maxChars 0 disables the check.
func ContentTooLong(content string, maxChars int) string {
	trimmed := strings.TrimSpace(content)
	n := utf16Len(trimmed)
	if maxChars > 0 && n > maxChars {
		return fmt.Sprintf("too long (%d chars, max %d) — split into one fact per entry", n, maxChars)
	}
	return ""
}

// utf16Len counts UTF-16 code units, matching JS String.length so the
// limits and reported counts agree with the TS server byte-for-byte.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}
