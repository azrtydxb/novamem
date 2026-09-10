package conformance

// A minimal shape validator with zod-passthrough semantics, so the suite
// files read like their TypeScript predecessors: required fields must be
// present with the right type, unknown fields always pass, Opt marks a
// field that may be absent, Null wraps a type that may be JSON null.

import (
	"fmt"
	"math"
)

// Type checks one JSON-decoded value.
type Type interface {
	check(path string, v any) error
}

// Schema is an object shape: every listed field is required unless
// wrapped in Opt; unknown fields pass (zod .passthrough()).
type Schema map[string]Type

func (s Schema) check(path string, v any) error {
	obj, ok := v.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: expected object, got %T", path, v)
	}
	for name, ft := range s {
		fv, present := obj[name]
		if opt, isOpt := ft.(optType); isOpt {
			if !present {
				continue
			}
			ft = opt.inner
		} else if !present {
			return fmt.Errorf("%s.%s: required field missing", path, name)
		}
		if err := ft.check(path+"."+name, fv); err != nil {
			return err
		}
	}
	return nil
}

// Validate checks a decoded JSON value against a schema and returns a
// descriptive error naming the failing path.
func Validate(v any, s Type) error { return s.check("$", v) }

type primType string

func (p primType) check(path string, v any) error {
	switch p {
	case "string":
		if _, ok := v.(string); !ok {
			return fmt.Errorf("%s: expected string, got %T", path, v)
		}
	case "number":
		if f, ok := v.(float64); !ok || math.IsNaN(f) {
			if !ok {
				return fmt.Errorf("%s: expected number, got %T", path, v)
			}
		}
	case "bool":
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("%s: expected bool, got %T", path, v)
		}
	case "any":
	}
	return nil
}

// Str / Num / Bool / Any are the primitive field types.
const (
	Str  = primType("string")
	Num  = primType("number")
	Bool = primType("bool")
	Any  = primType("any")
)

type optType struct{ inner Type }

func (o optType) check(path string, v any) error { return o.inner.check(path, v) }

// Opt marks an object field as optional (absent passes; present values
// are checked). Only meaningful directly inside a Schema.
func Opt(t Type) Type { return optType{t} }

type nullType struct{ inner Type }

func (n nullType) check(path string, v any) error {
	if v == nil {
		return nil
	}
	return n.inner.check(path, v)
}

// Null wraps a type so JSON null also passes (zod .nullable()).
func Null(t Type) Type { return nullType{t} }

type arrType struct{ elem Type }

func (a arrType) check(path string, v any) error {
	items, ok := v.([]any)
	if !ok {
		return fmt.Errorf("%s: expected array, got %T", path, v)
	}
	for i, item := range items {
		if err := a.elem.check(fmt.Sprintf("%s[%d]", path, i), item); err != nil {
			return err
		}
	}
	return nil
}

// Arr checks every element against the given type.
func Arr(elem Type) Type { return arrType{elem} }

type enumType []string

func (e enumType) check(path string, v any) error {
	s, ok := v.(string)
	if !ok {
		return fmt.Errorf("%s: expected string enum, got %T", path, v)
	}
	for _, allowed := range e {
		if s == allowed {
			return nil
		}
	}
	return fmt.Errorf("%s: %q not in %v", path, s, []string(e))
}

// Enum passes only the listed string values.
func Enum(values ...string) Type { return enumType(values) }

type mapType struct{ elem Type }

func (m mapType) check(path string, v any) error {
	obj, ok := v.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: expected object, got %T", path, v)
	}
	for k, mv := range obj {
		if err := m.elem.check(path+"."+k, mv); err != nil {
			return err
		}
	}
	return nil
}

// MapOf checks every value of a string-keyed object (zod z.record).
func MapOf(elem Type) Type { return mapType{elem} }
