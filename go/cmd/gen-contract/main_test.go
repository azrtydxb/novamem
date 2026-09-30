package main

import (
	"encoding/json"
	"testing"
)

// proved by: returning the node unchanged from jsonSchema fails this
// test (the nested nullable survives, and a null is rejected).
func TestJSONSchemaTranslatesNullable(t *testing.T) {
	in := map[string]any{
		"type":     "object",
		"required": []any{"id"},
		"properties": map[string]any{
			"id":   map[string]any{"type": "string", "nullable": true},
			"tier": map[string]any{"type": "string", "enum": []any{"warm", "cold"}, "nullable": true},
			"n":    map[string]any{"type": "integer", "nullable": false},
			"list": map[string]any{"type": "array", "items": map[string]any{"type": "number", "nullable": true}},
		},
	}
	got, _ := json.Marshal(jsonSchema(in, "t"))
	want := `{"properties":{"id":{"type":["string","null"]},"list":{"items":{"type":["number","null"]},"type":"array"},` +
		`"n":{"type":"integer"},"tier":{"enum":["warm","cold",null],"type":["string","null"]}},"required":["id"],"type":"object"}`
	if string(got) != want {
		t.Fatalf("jsonSchema =\n%s\nwant\n%s", got, want)
	}
	if in["properties"].(map[string]any)["id"].(map[string]any)["nullable"] != true {
		t.Fatal("jsonSchema mutated its input; the OpenAPI document shares these maps")
	}
}

// A property literally named "nullable" is data, not the keyword.
func TestJSONSchemaLeavesAPropertyNamedNullable(t *testing.T) {
	in := map[string]any{"type": "object", "properties": map[string]any{"nullable": map[string]any{"type": "boolean"}}}
	got, _ := json.Marshal(jsonSchema(in, "t"))
	if string(got) != `{"properties":{"nullable":{"type":"boolean"}},"type":"object"}` {
		t.Fatalf("got %s", got)
	}
}
