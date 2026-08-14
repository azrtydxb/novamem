// Sensitivity inference + read-side visibility. Transcribed from
// engine/index.ts inferSensitivity / withSensitivityMetadata /
// isSensitivityVisible / isInactiveMemory.
package engine

import (
	"regexp"
	"time"
)

var sensitivityOrder = map[string]int{"public": 0, "internal": 1, "private": 2, "sensitive": 3}

const defaultMaxSensitivity = "private"

// Exact regex from inferSensitivity (engine/index.ts).
var sensitiveContentRe = regexp.MustCompile(`(?i)\b(api[_ -]?key|token|secret|password|private[_ -]?key|bearer|sk-[a-z0-9_-]{8,})\b`)

func normalizeSensitivity(v any) string {
	s, _ := v.(string)
	if _, ok := sensitivityOrder[s]; ok {
		return s
	}
	return ""
}

// InferSensitivity — precedence: explicit request field, then
// metadata.sensitivity, then the secret-material content sniff, then
// "private".
func InferSensitivity(content string, metadata map[string]any, explicit string) string {
	if s := normalizeSensitivity(explicit); s != "" {
		return s
	}
	if metadata != nil {
		if s := normalizeSensitivity(metadata["sensitivity"]); s != "" {
			return s
		}
	}
	if sensitiveContentRe.MatchString(content) {
		return "sensitive"
	}
	return "private"
}

// isSensitivityVisible — maxSensitivity "" defaults to "private".
func isSensitivityVisible(metadata map[string]any, maxSensitivity string) bool {
	maxLevel, ok := sensitivityOrder[normalizeSensitivity(maxSensitivity)]
	if !ok {
		maxLevel = sensitivityOrder[defaultMaxSensitivity]
	}
	level := sensitivityOrder[defaultMaxSensitivity]
	if metadata != nil {
		if s := normalizeSensitivity(metadata["sensitivity"]); s != "" {
			level = sensitivityOrder[s]
		}
	}
	return level <= maxLevel
}

// isInactiveMemory hides superseded/deprecated lifecycle states,
// fact_inactive rows, and entries whose metadata.expiresAt TTL has
// passed (reads hide them immediately; the decay reaper hard-deletes
// later).
func isInactiveMemory(metadata map[string]any) bool {
	if metadata == nil {
		return false
	}
	if status, _ := metadata["lifecycleStatus"].(string); status == "superseded" || status == "deprecated" {
		return true
	}
	// TS truthiness: any non-falsy fact_inactive value hides the row.
	switch v := metadata["fact_inactive"].(type) {
	case bool:
		if v {
			return true
		}
	case string:
		if v != "" {
			return true
		}
	case float64:
		if v != 0 {
			return true
		}
	case nil:
	default:
		return true // objects/arrays are truthy in JS
	}
	if expiresAt, ok := metadata["expiresAt"].(string); ok {
		if t, err := parseJSDate(expiresAt); err == nil && !t.After(time.Now()) {
			return true
		}
	}
	return false
}

// parseJSDate approximates Date.parse for the ISO-8601 strings the
// schema layer admits (zod .datetime({offset:true}) — RFC3339 with Z or
// a numeric offset, optional fractional seconds).
func parseJSDate(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, s)
}
