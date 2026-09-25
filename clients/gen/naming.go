package main

import (
	"strings"
	"unicode"
)

// words splits a wire or Go name into lower-case words:
// "contentMode" → [content mode], "UserID" → [user id], "max_entries" → [max entries].
func words(s string) []string {
	var out []string
	var cur []rune
	rs := []rune(s)
	flush := func() {
		if len(cur) > 0 {
			out = append(out, strings.ToLower(string(cur)))
			cur = cur[:0]
		}
	}
	for i, r := range rs {
		switch {
		case r == '_' || r == '-' || r == ' ' || r == '.':
			flush()
		case unicode.IsUpper(r):
			// A capital starts a word, unless it continues an acronym that
			// is not about to hand over to a new lower-case word.
			if i > 0 && (unicode.IsLower(rs[i-1]) || unicode.IsDigit(rs[i-1]) ||
				(i+1 < len(rs) && unicode.IsLower(rs[i+1]) && unicode.IsUpper(rs[i-1]))) {
				flush()
			}
			cur = append(cur, r)
		default:
			cur = append(cur, r)
		}
	}
	flush()
	return out
}

func title(w string) string {
	if w == "" {
		return w
	}
	return strings.ToUpper(w[:1]) + w[1:]
}

// pascal: "contentMode" → "ContentMode".
func pascal(s string) string {
	var b strings.Builder
	for _, w := range words(s) {
		b.WriteString(title(w))
	}
	return b.String()
}

// camel: "ContentMode" → "contentMode".
func camel(s string) string {
	ws := words(s)
	if len(ws) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(ws[0])
	for _, w := range ws[1:] {
		b.WriteString(title(w))
	}
	return b.String()
}

// snake: "SessionRecap" → "session_recap".
func snake(s string) string { return strings.Join(words(s), "_") }

// upperSnake: "contentMode" → "CONTENT_MODE".
func upperSnake(s string) string { return strings.ToUpper(snake(s)) }
