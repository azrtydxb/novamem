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

// pyKeywords are the names Python will not accept as identifiers.
var pyKeywords = map[string]bool{
	"False": true, "None": true, "True": true, "and": true, "as": true, "assert": true,
	"async": true, "await": true, "break": true, "class": true, "continue": true,
	"def": true, "del": true, "elif": true, "else": true, "except": true,
	"finally": true, "for": true, "from": true, "global": true, "if": true,
	"import": true, "in": true, "is": true, "lambda": true, "nonlocal": true,
	"not": true, "or": true, "pass": true, "raise": true, "return": true,
	"try": true, "while": true, "with": true, "yield": true,
}

// pyident: snake_case, with a trailing underscore on a keyword
// ("Import" → "import_").
func pyident(s string) string {
	id := snake(s)
	if pyKeywords[id] {
		return id + "_"
	}
	return id
}

// rustKeywords are the names Rust needs as raw identifiers (r#type).
var rustKeywords = map[string]bool{
	"as": true, "break": true, "const": true, "continue": true, "crate": true, "else": true,
	"enum": true, "extern": true, "false": true, "fn": true, "for": true, "if": true,
	"impl": true, "in": true, "let": true, "loop": true, "match": true, "mod": true,
	"move": true, "mut": true, "pub": true, "ref": true, "return": true, "self": true,
	"static": true, "struct": true, "super": true, "trait": true, "true": true,
	"type": true, "unsafe": true, "use": true, "where": true, "while": true,
	"async": true, "await": true, "dyn": true, "abstract": true, "become": true,
	"box": true, "do": true, "final": true, "macro": true, "override": true,
	"priv": true, "typeof": true, "unsized": true, "virtual": true, "yield": true, "try": true,
}

// rustident: snake_case, raw where Rust reserves the word ("type" → "r#type").
func rustident(s string) string {
	id := snake(s)
	if rustKeywords[id] {
		return "r#" + id
	}
	return id
}

// cKeywords are C and C++ reserved words: a C header has to compile as
// C++ too, where a struct field named "namespace" is a syntax error.
var cKeywords = map[string]bool{
	"auto": true, "bool": true, "break": true, "case": true, "catch": true, "char": true,
	"class": true, "const": true, "continue": true, "default": true, "delete": true,
	"do": true, "double": true, "else": true, "enum": true, "explicit": true,
	"export": true, "extern": true, "false": true, "float": true, "for": true,
	"friend": true, "goto": true, "if": true, "inline": true, "int": true, "long": true,
	"mutable": true, "namespace": true, "new": true, "operator": true, "private": true,
	"protected": true, "public": true, "register": true, "restrict": true, "return": true,
	"short": true, "signed": true, "sizeof": true, "static": true, "struct": true,
	"switch": true, "template": true, "this": true, "throw": true, "true": true,
	"try": true, "typedef": true, "typename": true, "union": true, "unsigned": true,
	"using": true, "virtual": true, "void": true, "volatile": true, "while": true,
}

// cident: snake_case, with a trailing underscore on a C or C++ keyword
// ("namespace" → "namespace_").
func cident(s string) string {
	id := snake(s)
	if cKeywords[id] {
		return id + "_"
	}
	return id
}
