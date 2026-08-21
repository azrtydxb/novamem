package initcli

// Idempotent merge helpers for the host config files we touch. We never
// clobber: read what is there, set only the keys we own, write it back.
//
// Key order is load-bearing. JSON.stringify preserves insertion order,
// so the TypeScript installer appended "novamem" AFTER whatever servers
// the user already had and left unrelated top-level keys where they sat.
// Go's encoding/json sorts map keys, which would reorder a user's file
// on every run and break the golden fixtures — so documents are held in
// an ordered representation and emitted by hand.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Doc is a JSON object that remembers the order its keys arrived in.
// Values are any of: nil, bool, float64, string, []any, *Doc.
type Doc struct {
	keys   []string
	values map[string]any
}

// NewDoc returns an empty ordered document.
func NewDoc() *Doc {
	return &Doc{values: map[string]any{}}
}

// Len reports how many keys the document holds.
func (d *Doc) Len() int { return len(d.keys) }

// Keys returns the keys in insertion order.
func (d *Doc) Keys() []string { return append([]string(nil), d.keys...) }

// Get returns the value at key and whether it was present.
func (d *Doc) Get(key string) (any, bool) {
	v, ok := d.values[key]
	return v, ok
}

// Set writes key, appending it if new and keeping its position if not —
// the update-in-place that stops a re-run from shuffling the file.
func (d *Doc) Set(key string, value any) {
	if _, exists := d.values[key]; !exists {
		d.keys = append(d.keys, key)
	}
	d.values[key] = value
}

// Child returns the *Doc at key, creating it when absent or when the
// existing value is not an object (mirroring deepSet's replacement of a
// non-object on the path).
func (d *Doc) Child(key string) *Doc {
	if v, ok := d.values[key]; ok {
		if sub, isDoc := v.(*Doc); isDoc {
			return sub
		}
	}
	sub := NewDoc()
	d.Set(key, sub)
	return sub
}

// DeepSet sets a value at a key path, creating intermediate objects and
// replacing non-object segments along the way.
func (d *Doc) DeepSet(path []string, value any) {
	if len(path) == 0 {
		return
	}
	cur := d
	for _, seg := range path[:len(path)-1] {
		cur = cur.Child(seg)
	}
	cur.Set(path[len(path)-1], value)
}

// DeepGet returns the value at a key path, or nil when any segment is
// missing or not an object.
func (d *Doc) DeepGet(path []string) any {
	var cur any = d
	for _, seg := range path {
		sub, ok := cur.(*Doc)
		if !ok {
			return nil
		}
		v, present := sub.Get(seg)
		if !present {
			return nil
		}
		cur = v
	}
	return cur
}

// ParseJSONLoose parses tolerantly: missing, empty, invalid, or
// non-object input all yield an empty document, so the merge step always
// has an object root to work against.
func ParseJSONLoose(raw string) *Doc {
	if strings.TrimSpace(raw) == "" {
		return NewDoc()
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return NewDoc()
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return NewDoc() // arrays and scalars are not object roots
	}
	doc, err := decodeObject(dec)
	if err != nil {
		return NewDoc()
	}
	return doc
}

// decodeObject reads an object body, the opening brace already consumed.
func decodeObject(dec *json.Decoder) (*Doc, error) {
	doc := NewDoc()
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		if delim, ok := tok.(json.Delim); ok && delim == '}' {
			return doc, nil
		}
		key, ok := tok.(string)
		if !ok {
			return nil, fmt.Errorf("object key is %T, not a string", tok)
		}
		value, err := decodeValue(dec)
		if err != nil {
			return nil, err
		}
		doc.Set(key, value)
	}
}

// decodeValue reads one value, descending into objects and arrays so
// nested key order survives too.
func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := tok.(json.Delim); ok {
		switch delim {
		case '{':
			return decodeObject(dec)
		case '[':
			arr := []any{}
			for {
				if !dec.More() {
					if _, err := dec.Token(); err != nil { // consume ']'
						return nil, err
					}
					return arr, nil
				}
				item, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, item)
			}
		default:
			return nil, fmt.Errorf("unexpected delimiter %q", delim)
		}
	}
	return tok, nil
}

// StringifyJSON renders a document the way JSON.stringify(doc, null, 2)
// does: two-space indent, no HTML escaping, and a trailing newline.
func StringifyJSON(doc *Doc) string {
	var b strings.Builder
	writeDoc(&b, doc, 0)
	b.WriteString("\n")
	return b.String()
}

func writeDoc(b *strings.Builder, doc *Doc, depth int) {
	if doc.Len() == 0 {
		b.WriteString("{}")
		return
	}
	b.WriteString("{\n")
	for i, key := range doc.keys {
		writeIndent(b, depth+1)
		writeJSONString(b, key)
		b.WriteString(": ")
		writeValue(b, doc.values[key], depth+1)
		if i < len(doc.keys)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	writeIndent(b, depth)
	b.WriteString("}")
}

func writeValue(b *strings.Builder, v any, depth int) {
	switch val := v.(type) {
	case *Doc:
		writeDoc(b, val, depth)
	case []any:
		if len(val) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, item := range val {
			writeIndent(b, depth+1)
			writeValue(b, item, depth+1)
			if i < len(val)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		writeIndent(b, depth)
		b.WriteString("]")
	case string:
		writeJSONString(b, val)
	case nil:
		b.WriteString("null")
	default:
		// json.Number, bool, and anything else round-trip through the
		// standard encoder with HTML escaping off, matching
		// JSON.stringify's treatment of <, > and &.
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(val); err != nil {
			b.WriteString("null")
			return
		}
		b.WriteString(strings.TrimRight(buf.String(), "\n"))
	}
}

func writeJSONString(b *strings.Builder, s string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		b.WriteString(`""`)
		return
	}
	b.WriteString(strings.TrimRight(buf.String(), "\n"))
}

func writeIndent(b *strings.Builder, depth int) {
	b.WriteString(strings.Repeat("  ", depth))
}
