// POST /v1/session-recap — typed recap items ingested as durable
// memories. Transcribed from routes/data-plane.ts (/v1/session-recap
// handler) + routes/schemas.ts SessionRecapBody. The body is .strict()
// in TS: unknown fields are rejected, unlike the other data-plane bodies.
package httpapi

import (
	"fmt"
	"net/http"

	"github.com/azrtydxb/novamem/go/internal/engine"
)

var recapGroups = []struct {
	field      string
	namespace  string
	memoryType string
}{
	{"decisions", "decisions", "decision"},
	{"setupFacts", "current-setup", "setup_fact"},
	{"rootCauses", "root-causes", "bug_root_cause"},
	{"preferences", "user", "user_preference"},
	{"projectConventions", "project-conventions", "project_convention"},
	{"safetyConstraints", "safety", "safety_constraint"},
	{"other", "", "general"}, // namespace resolved below (body.namespace ?? "memory")
}

var recapKnownKeys = map[string]bool{
	"decisions": true, "setupFacts": true, "rootCauses": true, "preferences": true,
	"projectConventions": true, "safetyConstraints": true, "other": true,
	"namespace": true, "source": true, "sourceType": true, "capturedFrom": true,
	"agentName": true, "confidence": true, "force": true, "project": true,
	"metadata": true, "sensitivity": true,
}

func (s *server) handleSessionRecap(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	m, decodeErr := decodeBody(body, false)
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return
	}
	c := &v{m: m}
	// .strict(): unknown keys → zod unrecognized_keys.
	for key := range m {
		if !recapKnownKeys[key] {
			c.add("", fmt.Sprintf("Unrecognized key(s) in object: '%s'", key), "unrecognized_keys")
		}
	}
	items := map[string][]string{}
	for _, g := range recapGroups {
		// z.array(z.string().min(12).max(4000)).optional()
		arr, ok := c.strArray(g.field, 1<<30,
			func(s string) bool { return utf16Len(s) >= 12 && utf16Len(s) <= 4000 },
			"String must contain at least 12 character(s)")
		if ok {
			items[g.field] = arr
		}
	}
	namespace, _ := c.str("namespace", false, 1, 128)
	source, _ := c.str("source", false, 1, 256)
	sourceType, _ := c.str("sourceType", false, 1, 64)
	capturedFrom, _ := c.str("capturedFrom", false, 1, 256)
	var agentName *string
	if a, ok := c.nullableStr("agentName", 0, 128); ok {
		agentName = &a
	}
	var confidence *float64
	if n, ok := c.number("confidence", 0, 1); ok {
		confidence = &n
	}
	force, _ := c.boolean("force")
	project, _ := c.projectRef("project")
	// SessionRecapBody uses a plain record for metadata (no MetadataRule
	// caps — schemas.ts) so only the type is checked here.
	var metadata map[string]any
	if raw, present := m["metadata"]; present && raw != nil {
		mm, ok := raw.(map[string]any)
		if !ok {
			c.add("metadata", fmt.Sprintf("Expected object, received %s", jsonType(raw)), "invalid_type")
		} else {
			metadata = mm
		}
	}
	sensitivity, _ := c.enum("sensitivity", "public", "internal", "private", "sensitive")
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}

	userID := s.userID(r)
	scope := projectScope{Project: project}
	if !s.checkProjectAccess(w, r, userID, &scope, false) {
		return
	}

	if source == "" {
		source = "memory_session_recap"
	}
	if sourceType == "" {
		sourceType = "summary"
	}
	if capturedFrom == "" {
		capturedFrom = "memory_session_recap"
	}
	results := []engine.RememberResult{}
	saved := 0
	for _, g := range recapGroups {
		groupNamespace := namespace
		if groupNamespace == "" {
			groupNamespace = g.namespace
			if g.field == "other" {
				groupNamespace = "memory"
			}
		}
		for _, content := range items[g.field] {
			md := map[string]any{}
			for k, val := range metadata {
				md[k] = val
			}
			md["memoryType"] = g.memoryType
			md["recap"] = true
			result, err := s.engine.Capture(r.Context(), userID, engine.RememberRequest{
				Content:      content,
				Namespace:    groupNamespace,
				Source:       source,
				AgentName:    agentName,
				Project:      scope.Project,
				Metadata:     md,
				SourceType:   &sourceType,
				CapturedFrom: &capturedFrom,
				Confidence:   confidence,
				Force:        force,
				Sensitivity:  sensitivity,
			})
			if err != nil {
				s.sendEngineErr(w, r, err)
				return
			}
			if result.ID != nil {
				saved++
			}
			results = append(results, result)
		}
	}
	writeJSONValue(w, http.StatusCreated, map[string]any{"saved": saved, "results": results})
}
