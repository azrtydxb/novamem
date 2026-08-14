// Request-body validation reproducing the TS server's zod schemas
// (routes/schemas.ts) and the error envelope from http.ts's error
// handler: 400 {"error":"invalid request body","issues":[{path,message,
// code}]}. Codes follow zod's issue-code vocabulary (invalid_type,
// too_small, too_big, invalid_string, invalid_enum_value, custom) —
// the conformance suite pins the envelope shape and the "content" path
// entry; messages follow zod's default wording.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// MaxContentBytes — routes/schemas.ts MAX_CONTENT_BYTES. zod's .max()
// counts UTF-16 code units, not bytes; utf16Len keeps parity.
const MaxContentBytes = 256 * 1024

const (
	maxMetadataKeyLen = 64
	maxMetadataBytes  = 8 * 1024
)

type issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
	Code    string `json:"code"`
}

// Error lets decodeBody return an issue through the error channel; see
// sendBodyErr for the envelope split.
func (i *issue) Error() string { return i.Message }

// utf16Len counts UTF-16 code units (JS String.length).
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

var (
	// ProjectRefRule charset (schemas.ts). The TS rule NFKC-normalises
	// before this check (homoglyph hardening, issue #23); Go's stdlib has
	// no NFKC and pulling x/text in for it is out of slice-2 budget, so
	// exotic homoglyph refs may pass here that TS would collapse first —
	// resolveProjectRef remains the actual access boundary either way.
	projectRefRe = regexp.MustCompile(`^[\x21-\x7e \x{0080}-\x{ffff}]+$`)
	namespaceRe  = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9._:-]*$`)
	// zod .datetime({offset:true}): ISO-8601 with T, seconds, optional
	// fractional seconds, and Z or a numeric offset.
	isoDatetimeRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)
)

// v accumulates issues while pulling typed fields out of a decoded JSON
// object. Unknown fields are ignored (the TS bodies are not .strict()).
type v struct {
	m      map[string]any
	issues []issue
}

func (c *v) add(path, message, code string) {
	c.issues = append(c.issues, issue{Path: path, Message: message, Code: code})
}

// str returns (value, present). present=false covers both absent and
// invalid — invalid already recorded an issue.
func (c *v) str(key string, required bool, min, max int) (string, bool) {
	raw, ok := c.m[key]
	if !ok || raw == nil {
		if required {
			c.add(key, "Required", "invalid_type")
		}
		return "", false
	}
	s, ok := raw.(string)
	if !ok {
		c.add(key, fmt.Sprintf("Expected string, received %s", jsonType(raw)), "invalid_type")
		return "", false
	}
	n := utf16Len(s)
	if n < min {
		c.add(key, fmt.Sprintf("String must contain at least %d character(s)", min), "too_small")
		return "", false
	}
	if n > max {
		c.add(key, fmt.Sprintf("String must contain at most %d character(s)", max), "too_big")
		return "", false
	}
	return s, true
}

// nullableStr treats JSON null like absent (matching .optional().nullable()).
func (c *v) nullableStr(key string, min, max int) (string, bool) {
	return c.str(key, false, min, max)
}

func (c *v) boolean(key string) (bool, bool) {
	raw, ok := c.m[key]
	if !ok || raw == nil {
		return false, false
	}
	b, ok := raw.(bool)
	if !ok {
		c.add(key, fmt.Sprintf("Expected boolean, received %s", jsonType(raw)), "invalid_type")
		return false, false
	}
	return b, true
}

func (c *v) number(key string, min, max float64) (float64, bool) {
	raw, ok := c.m[key]
	if !ok || raw == nil {
		return 0, false
	}
	n, ok := raw.(float64)
	if !ok {
		c.add(key, fmt.Sprintf("Expected number, received %s", jsonType(raw)), "invalid_type")
		return 0, false
	}
	if n < min {
		c.add(key, fmt.Sprintf("Number must be greater than or equal to %g", min), "too_small")
		return 0, false
	}
	if n > max {
		c.add(key, fmt.Sprintf("Number must be less than or equal to %g", max), "too_big")
		return 0, false
	}
	return n, true
}

// positiveInt — z.number().int().positive().max(max).
func (c *v) positiveInt(key string, max int) (int, bool) {
	raw, ok := c.m[key]
	if !ok || raw == nil {
		return 0, false
	}
	n, ok := raw.(float64)
	if !ok {
		c.add(key, fmt.Sprintf("Expected number, received %s", jsonType(raw)), "invalid_type")
		return 0, false
	}
	if n != float64(int64(n)) {
		c.add(key, "Expected integer, received float", "invalid_type")
		return 0, false
	}
	i := int(n)
	if i <= 0 {
		c.add(key, "Number must be greater than 0", "too_small")
		return 0, false
	}
	if i > max {
		c.add(key, fmt.Sprintf("Number must be less than or equal to %d", max), "too_big")
		return 0, false
	}
	return i, true
}

func (c *v) enum(key string, allowed ...string) (string, bool) {
	s, ok := c.str(key, false, 0, 1<<30)
	if !ok {
		return "", false
	}
	for _, a := range allowed {
		if s == a {
			return s, true
		}
	}
	c.add(key, fmt.Sprintf("Invalid enum value. Expected '%s', received '%s'",
		strings.Join(allowed, "' | '"), s), "invalid_enum_value")
	return "", false
}

func (c *v) datetime(key, message string) (string, bool) {
	s, ok := c.str(key, false, 0, 1<<30)
	if !ok {
		return "", false
	}
	if !isoDatetimeRe.MatchString(s) {
		if message == "" {
			message = "Invalid datetime"
		}
		c.add(key, message, "invalid_string")
		return "", false
	}
	return s, true
}

// projectRef — ProjectRefRule (schemas.ts): 1..128 chars, printable
// charset, message "project ref contains control characters".
func (c *v) projectRef(key string) (*string, bool) {
	s, ok := c.nullableStr(key, 1, 128)
	if !ok {
		return nil, false
	}
	if !projectRefRe.MatchString(s) {
		c.add(key, "project ref contains control characters", "invalid_string")
		return nil, false
	}
	return &s, true
}

// namespaceRule — NamespaceRule (schemas.ts) for includeNamespaces items.
func validNamespaceItem(s string) bool {
	return utf16Len(s) >= 1 && utf16Len(s) <= 128 && namespaceRe.MatchString(s)
}

// metadata — MetadataRule: object, keys ≤64 chars, serialized ≤8KB.
func (c *v) metadata(key string) (map[string]any, bool) {
	raw, ok := c.m[key]
	if !ok || raw == nil {
		return nil, false
	}
	m, ok := raw.(map[string]any)
	if !ok {
		c.add(key, fmt.Sprintf("Expected object, received %s", jsonType(raw)), "invalid_type")
		return nil, false
	}
	for k := range m {
		if utf16Len(k) > maxMetadataKeyLen {
			c.add(key, fmt.Sprintf("metadata key too long (%d-char max)", maxMetadataKeyLen), "custom")
			return nil, false
		}
	}
	// JSON.stringify(v).length in TS; a re-marshal length is the closest
	// Go equivalent (key order/escaping can differ by a few bytes — the
	// limit is a bound, not a precise contract).
	b, err := json.Marshal(m)
	if err != nil || len(b) > maxMetadataBytes {
		c.add(key, "metadata too large (8KB max)", "custom")
		return nil, false
	}
	return m, true
}

func (c *v) strArray(key string, maxItems int, itemCheck func(string) bool, itemMessage string) ([]string, bool) {
	raw, ok := c.m[key]
	if !ok || raw == nil {
		return nil, false
	}
	arr, ok := raw.([]any)
	if !ok {
		c.add(key, fmt.Sprintf("Expected array, received %s", jsonType(raw)), "invalid_type")
		return nil, false
	}
	if len(arr) > maxItems {
		c.add(key, fmt.Sprintf("Array must contain at most %d element(s)", maxItems), "too_big")
		return nil, false
	}
	out := make([]string, 0, len(arr))
	for i, item := range arr {
		s, ok := item.(string)
		if !ok {
			c.add(fmt.Sprintf("%s.%d", key, i), fmt.Sprintf("Expected string, received %s", jsonType(item)), "invalid_type")
			return nil, false
		}
		if !itemCheck(s) {
			c.add(fmt.Sprintf("%s.%d", key, i), itemMessage, "invalid_string")
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

func jsonType(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case nil:
		return "null"
	default:
		return "unknown"
	}
}

// errMalformedJSON is the body-parser failure Fastify answers before any
// schema runs, so it carries no `issues` array. Kept distinct from a
// schema issue because the two envelopes differ.
var errMalformedJSON = errors.New("Body is not valid JSON but content-type is set to 'application/json'")

// decodeBody unmarshals a JSON object body. optional=true admits an
// empty body as an empty object (RecentBody.optional()).
//
// The three failure modes are the three Fastify/Zod produces, and they
// are distinct on the wire: unparseable input is a body-parser error
// (errMalformedJSON), valid JSON that isn't an object is a schema
// issue with an empty path, and an absent body on a required schema is
// "Required".
func decodeBody(body []byte, optional bool) (map[string]any, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || trimmed == "null" {
		if optional {
			return map[string]any{}, nil
		}
		return nil, &issue{Path: "", Message: "Required", Code: "invalid_type"}
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, errMalformedJSON
	}
	m, ok := parsed.(map[string]any)
	if !ok {
		return nil, &issue{
			Path:    "",
			Message: "Invalid input: expected object, received " + jsonType(parsed),
			Code:    "invalid_type",
		}
	}
	return m, nil
}

// sendBodyErr answers whichever of decodeBody's two envelopes applies.
func (s *server) sendBodyErr(w http.ResponseWriter, err error) {
	var i *issue
	if errors.As(err, &i) {
		s.sendIssues(w, []issue{*i})
		return
	}
	s.sendError(w, http.StatusBadRequest, err.Error())
}

// nullableInt — z.number().int().nonnegative().nullable().optional(),
// the admin quota-override shape: absent and null both mean "clear the
// override", so both return nil.
func (c *v) nullableInt(key string) *int {
	raw, ok := c.m[key]
	if !ok || raw == nil {
		return nil
	}
	n, ok := raw.(float64)
	if !ok {
		c.add(key, fmt.Sprintf("Expected number, received %s", jsonType(raw)), "invalid_type")
		return nil
	}
	if n != float64(int64(n)) {
		c.add(key, "Expected integer, received float", "invalid_type")
		return nil
	}
	if n < 0 {
		c.add(key, "Number must be greater than or equal to 0", "too_small")
		return nil
	}
	i := int(n)
	return &i
}
