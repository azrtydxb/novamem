package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/azrtydxb/novamem/clients/contract"
)

// Kind is what a generated type is.
type Kind int

// The three kinds of generated type.
const (
	KObject Kind = iota // a record with named fields
	KEnum               // a closed set of strings
	KAlias              // a named array or map
)

// TypeRef is a field's type: exactly one of Prim, Named, Array or Map.
type TypeRef struct {
	// Prim is string, int32, int64, float, bool, any or datetime.
	Prim  string
	Named string
	Array *TypeRef
	Map   *TypeRef
}

// Field is one property of an object type, sorted by Wire.
type Field struct {
	Name     string // PascalCase; templates re-case it
	Wire     string
	Ref      TypeRef
	Required bool
	Nullable bool
	Doc      string
}

// Type is one generated type.
type Type struct {
	Name   string
	Kind   Kind
	Fields []Field
	Elem   *TypeRef
	Enum   []string
	Doc    string
}

// IsObject, IsEnum and IsAlias let templates branch on Kind by name.
func (t Type) IsObject() bool { return t.Kind == KObject }

// IsEnum reports whether t is a closed set of strings.
func (t Type) IsEnum() bool { return t.Kind == KEnum }

// IsAlias reports whether t is a named array or map.
func (t Type) IsAlias() bool { return t.Kind == KAlias }

// DatetimeFields is the sorted, de-duplicated wire names of every
// timestamp field, for SDKs that normalise timestamps at runtime.
func (m Model) DatetimeFields() []string {
	seen := map[string]bool{}
	var out []string
	for _, t := range m.Types {
		for _, f := range t.Fields {
			if f.Ref.Prim == "datetime" && !seen[f.Wire] {
				seen[f.Wire] = true
				out = append(out, f.Wire)
			}
		}
	}
	sort.Strings(out)
	return out
}

// Model is what every template receives.
type Model struct {
	Types   []Type
	Methods []contract.Method
}

// schema is the subset of OpenAPI 3.0 the generator understands. Anything
// else it meets on a reachable type is an error, never a guess.
type schema struct {
	Ref                  string             `json:"$ref"`
	Type                 string             `json:"type"`
	Format               string             `json:"format"`
	Properties           map[string]*schema `json:"properties"`
	Required             []string           `json:"required"`
	Items                *schema            `json:"items"`
	Enum                 []any              `json:"enum"`
	Nullable             bool               `json:"nullable"`
	Description          string             `json:"description"`
	AdditionalProperties json.RawMessage    `json:"additionalProperties"`
	OneOf                []*schema          `json:"oneOf"`
	AnyOf                []*schema          `json:"anyOf"`
	AllOf                []*schema          `json:"allOf"`
}

type document struct {
	Paths      map[string]map[string]json.RawMessage `json:"paths"`
	Components struct {
		Schemas map[string]*schema `json:"schemas"`
	} `json:"components"`
}

type builder struct {
	doc   document
	types map[string]Type
	// source is the schema each name was built from, so a second, different
	// schema arriving at the same name is a collision rather than a silent
	// first-one-wins.
	source map[string]string
	// building guards against self-referential schemas.
	building map[string]bool
}

// int64Fields are integers that are sequence numbers and may outgrow 2^31
// (and, in TypeScript, 2^53 — which is why int64 is a string there).
var int64Fields = map[string]bool{"seq": true, "afterSeq": true, "nextSeq": true}

// BuildModel reads the OpenAPI JSON document and routes.json and returns
// every type reachable from a routes.json method's request or response.
func BuildModel(specPath, routesPath string) (*Model, error) {
	raw, err := os.ReadFile(specPath)
	if err != nil {
		return nil, err
	}
	b := &builder{types: map[string]Type{}, source: map[string]string{}, building: map[string]bool{}}
	if err := json.Unmarshal(raw, &b.doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", specPath, err)
	}
	routes, err := contract.LoadRoutes(routesPath)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(routes))
	for k := range routes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		for _, m := range routes[key].Methods {
			if m.Request != "" {
				s, ptr, err := b.requestBody(key)
				if err != nil {
					return nil, fmt.Errorf("%s (%s): %w", key, m.Name, err)
				}
				if err := b.named(m.Request, s, ptr); err != nil {
					return nil, err
				}
			}
			if m.Response != nil {
				if _, err := b.ref("#/components/schemas/"+*m.Response, "#/components/schemas/"+*m.Response); err != nil {
					return nil, err
				}
			}
		}
	}
	out := &Model{Methods: contract.Surface(routes)}
	for _, t := range b.types {
		out.Types = append(out.Types, t)
	}
	sort.Slice(out.Types, func(i, j int) bool { return out.Types[i].Name < out.Types[j].Name })
	return out, nil
}

// requestBody finds the inline JSON request schema of "METHOD /path".
func (b *builder) requestBody(key string) (*schema, string, error) {
	method, path, _ := strings.Cut(key, " ")
	method = strings.ToLower(method)
	opRaw, ok := b.doc.Paths[path][method]
	if !ok {
		return nil, "", fmt.Errorf("route not in the OpenAPI document")
	}
	var op struct {
		RequestBody struct {
			Content map[string]struct {
				Schema *schema `json:"schema"`
			} `json:"content"`
		} `json:"requestBody"`
	}
	if err := json.Unmarshal(opRaw, &op); err != nil {
		return nil, "", err
	}
	s := op.RequestBody.Content["application/json"].Schema
	if s == nil {
		return nil, "", fmt.Errorf("routes.json names a request type but the operation has no JSON request body")
	}
	ptr := "#/paths/" + escape(path) + "/" + method + "/requestBody/content/application~1json/schema"
	return s, ptr, nil
}

func escape(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1") }

// ref resolves a $ref to a named type, building it on first sight.
func (b *builder) ref(ref, ptr string) (string, error) {
	name, ok := strings.CutPrefix(ref, "#/components/schemas/")
	if !ok {
		return "", fmt.Errorf("unsupported $ref %q at %s", ref, ptr)
	}
	s, ok := b.doc.Components.Schemas[name]
	if !ok {
		return "", fmt.Errorf("unsupported $ref to missing schema %q at %s", name, ptr)
	}
	return name, b.named(name, s, "#/components/schemas/"+name)
}

// named registers s as the type called name.
func (b *builder) named(name string, s *schema, ptr string) error {
	src, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if prev, seen := b.source[name]; seen {
		if prev != string(src) {
			return fmt.Errorf("type name collision: %s at %s differs from the schema already generated under that name", name, ptr)
		}
		return nil
	}
	b.source[name] = string(src)
	if b.building[name] {
		return nil
	}
	b.building[name] = true
	defer delete(b.building, name)
	if err := unsupported(s, ptr); err != nil {
		return err
	}
	switch {
	case len(s.Enum) > 0:
		return b.add(Type{Name: name, Kind: KEnum, Enum: enumValues(s), Doc: s.Description})
	case s.Type == "object" && len(s.Properties) > 0:
		t := Type{Name: name, Kind: KObject, Doc: s.Description}
		req := map[string]bool{}
		for _, r := range s.Required {
			req[r] = true
		}
		wires := make([]string, 0, len(s.Properties))
		for w := range s.Properties {
			wires = append(wires, w)
		}
		sort.Strings(wires)
		for _, w := range wires {
			ps := s.Properties[w]
			ref, err := b.typeRef(name, w, ps, ptr+"/properties/"+escape(w))
			if err != nil {
				return err
			}
			t.Fields = append(t.Fields, Field{
				Name: pascal(w), Wire: w, Ref: ref,
				Required: req[w], Nullable: ps.Nullable, Doc: ps.Description,
			})
		}
		return b.add(t)
	default:
		ref, err := b.typeRef(name, "", s, ptr)
		if err != nil {
			return err
		}
		return b.add(Type{Name: name, Kind: KAlias, Elem: &ref, Doc: s.Description})
	}
}

func (b *builder) add(t Type) error {
	if prev, ok := b.types[t.Name]; ok && fmt.Sprint(prev) != fmt.Sprint(t) {
		return fmt.Errorf("type name collision: %s is generated from two different schemas", t.Name)
	}
	b.types[t.Name] = t
	return nil
}

// typeRef maps one schema to a field type. Inline objects and enums become
// named types called <Parent><Field>.
func (b *builder) typeRef(parent, field string, s *schema, ptr string) (TypeRef, error) {
	if err := unsupported(s, ptr); err != nil {
		return TypeRef{}, err
	}
	if s.Ref != "" {
		name, err := b.ref(s.Ref, ptr)
		return TypeRef{Named: name}, err
	}
	inline := parent + pascal(field)
	switch {
	case len(s.Enum) > 0:
		return TypeRef{Named: inline}, b.named(inline, s, ptr)
	case s.Type == "object" && len(s.Properties) > 0:
		return TypeRef{Named: inline}, b.named(inline, s, ptr)
	case s.Type == "object" || (s.Type == "" && len(s.AdditionalProperties) > 0):
		elem := TypeRef{Prim: "any"}
		var ap schema
		if len(s.AdditionalProperties) > 0 && s.AdditionalProperties[0] == '{' {
			if err := json.Unmarshal(s.AdditionalProperties, &ap); err != nil {
				return TypeRef{}, err
			}
			if ap.Type != "" || ap.Ref != "" {
				r, err := b.typeRef(inline, "Value", &ap, ptr+"/additionalProperties")
				if err != nil {
					return TypeRef{}, err
				}
				elem = r
			}
		}
		return TypeRef{Map: &elem}, nil
	case s.Type == "array":
		items := s.Items
		if items == nil {
			items = &schema{}
		}
		name := parent + pascal(field) + "Item"
		if field == "" {
			name = parent + "Item"
		}
		el, err := b.itemRef(name, items, ptr+"/items")
		return TypeRef{Array: &el}, err
	case (s.Type == "integer" || s.Type == "number") && (s.Format == "int64" || int64Fields[field]):
		// Sequence numbers are int64 even where the spec says "number".
		return TypeRef{Prim: "int64"}, nil
	case s.Type == "integer":
		return TypeRef{Prim: "int32"}, nil
	case s.Type == "number":
		return TypeRef{Prim: "float"}, nil
	case s.Type == "boolean":
		return TypeRef{Prim: "bool"}, nil
	case s.Type == "string" && s.Format == "date-time":
		return TypeRef{Prim: "datetime"}, nil
	case s.Type == "string":
		return TypeRef{Prim: "string"}, nil
	default:
		return TypeRef{Prim: "any"}, nil
	}
}

// itemRef is typeRef for array items, where an inline object is named
// <Parent><Field>Item rather than after a property.
func (b *builder) itemRef(name string, s *schema, ptr string) (TypeRef, error) {
	if err := unsupported(s, ptr); err != nil {
		return TypeRef{}, err
	}
	if (s.Type == "object" && len(s.Properties) > 0) || len(s.Enum) > 0 {
		return TypeRef{Named: name}, b.named(name, s, ptr)
	}
	return b.typeRef(strings.TrimSuffix(name, "Item"), "Item", s, ptr)
}

func unsupported(s *schema, ptr string) error {
	switch {
	case len(s.OneOf) > 0:
		return fmt.Errorf("unsupported oneOf at %s", ptr)
	case len(s.AnyOf) > 0:
		return fmt.Errorf("unsupported anyOf at %s", ptr)
	case len(s.AllOf) > 0:
		return fmt.Errorf("unsupported allOf at %s", ptr)
	}
	return nil
}

func enumValues(s *schema) []string {
	out := make([]string, 0, len(s.Enum))
	for _, v := range s.Enum {
		out = append(out, fmt.Sprint(v))
	}
	return out
}
