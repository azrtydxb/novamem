// Capture-path metadata derivation. Transcribed from engine/index.ts:
// inferMemoryType, scoreWorthiness, retentionPolicyFor, captureMetadata,
// mergeCaptureMetadata. Only the "inserted" branch is exercised in slice
// 2 (the semantic-dedup / supersede branches need the cold store —
// slice 3), but rows written by capture must carry the same metadata the
// TS server writes so decay/hygiene treat them identically.
package engine

import (
	"math"
	"regexp"
	"strings"
)

var memoryTypes = map[string]bool{
	"user_preference": true, "bug_root_cause": true, "decision": true,
	"deployment_state": true, "setup_fact": true, "project_convention": true,
	"safety_constraint": true, "general": true,
}

var (
	typePrefRe       = regexp.MustCompile(`\b(prefer|prefers|likes|wants|communication style|response style)\b`)
	typeBugRe        = regexp.MustCompile(`\b(root cause|post-?mortem|failed because|bug|incident|regression)\b`)
	typeDecisionRe   = regexp.MustCompile(`\b(decision|decided|chose|choose|selected|approved)\b`)
	typeDeployRe     = regexp.MustCompile(`\b(deploy|deployment|rollout|image|container|k3s|docker|ghcr|endpoint|runs on|host|port)\b`)
	typeSetupRe      = regexp.MustCompile(`\b(setup|current setup|configured|configuration|model|server|service|endpoint|runs on|host|port|version)\b`)
	typeConventionRe = regexp.MustCompile(`\b(convention|standard|pattern|workflow|project uses|codebase uses)\b`)
	typeSafetyRe     = regexp.MustCompile(`\b(safety|security|privacy|never|do not|don't|must not|credential|secret)\b`)
)

// InferMemoryType — caller-supplied metadata.memoryType wins when it is
// in the closed set; otherwise keyword inference over namespace+content.
func InferMemoryType(content, namespace string, metadata map[string]any) string {
	if metadata != nil {
		if explicit, _ := metadata["memoryType"].(string); memoryTypes[explicit] {
			return explicit
		}
	}
	hay := strings.ToLower(namespace + " " + content)
	switch {
	case typePrefRe.MatchString(hay):
		return "user_preference"
	case typeBugRe.MatchString(hay):
		return "bug_root_cause"
	case typeDecisionRe.MatchString(hay):
		return "decision"
	case typeDeployRe.MatchString(hay):
		return "deployment_state"
	case typeSetupRe.MatchString(hay):
		return "setup_fact"
	case typeConventionRe.MatchString(hay):
		return "project_convention"
	case typeSafetyRe.MatchString(hay):
		return "safety_constraint"
	default:
		return "general"
	}
}

var relevanceCuesRe = regexp.MustCompile(`(?i)\b(i|me|my|mine|we|our|us|user|users|team|wife|husband|partner|spouse|family|household|kids?|children|project|projects|repo|repository|codebase|deployment|deploy|server|service|workflow|preference|prefers?)\b`)

func clamp01(n float64) float64 {
	// Number(n.toFixed(3)) — round to 3 decimals, then clamp.
	n = math.Round(n*1000) / 1000
	return math.Max(0, math.Min(1, n))
}

// ScoreWorthiness — signals used by hygiene/decay. personalTerms is the
// deployment-specific vocabulary (config); slice 2 passes none.
func ScoreWorthiness(content, memoryType string, confidence float64, personalTerms []string) map[string]float64 {
	length := utf16Len(strings.TrimSpace(content))
	durable := 0.55
	if length >= 80 {
		durable = 0.9
	} else if length >= 40 {
		durable = 0.75
	}
	var reuse float64
	switch memoryType {
	case "user_preference", "setup_fact", "deployment_state", "project_convention", "safety_constraint":
		reuse = 0.85
	case "decision":
		reuse = 0.75
	case "bug_root_cause":
		reuse = 0.7
	default:
		reuse = 0.45
	}
	matchesPersonal := false
	for _, term := range personalTerms {
		escaped := regexp.QuoteMeta(strings.TrimSpace(term))
		if escaped == "" {
			continue
		}
		if re, err := regexp.Compile(`(?i)\b` + escaped + `\b`); err == nil && re.MatchString(content) {
			matchesPersonal = true
			break
		}
	}
	userRelevance := 0.65
	if matchesPersonal || relevanceCuesRe.MatchString(content) {
		userRelevance = 0.9
	}
	c := clamp01(confidence)
	overall := clamp01(clamp01(durable)*0.3 + clamp01(reuse)*0.3 + clamp01(userRelevance)*0.25 + c*0.15)
	return map[string]float64{
		"durable":         clamp01(durable),
		"reuseLikelihood": clamp01(reuse),
		"userRelevance":   clamp01(userRelevance),
		"confidence":      c,
		"overall":         overall,
	}
}

// RetentionPolicyFor — closed table from engine/index.ts.
func RetentionPolicyFor(memoryType string) map[string]any {
	switch memoryType {
	case "user_preference":
		return map[string]any{"policy": "long_lived", "baseEffectiveDays": 365, "supersedeAggressively": false}
	case "safety_constraint":
		return map[string]any{"policy": "long_lived", "baseEffectiveDays": 365, "supersedeAggressively": false}
	case "setup_fact":
		return map[string]any{"policy": "supersede_aggressively", "baseEffectiveDays": 60, "supersedeAggressively": true}
	case "deployment_state":
		return map[string]any{"policy": "current_only", "baseEffectiveDays": 30, "supersedeAggressively": true}
	case "decision":
		return map[string]any{"policy": "medium_long", "baseEffectiveDays": 180, "supersedeAggressively": false}
	case "bug_root_cause":
		return map[string]any{"policy": "medium", "baseEffectiveDays": 120, "supersedeAggressively": false}
	case "project_convention":
		return map[string]any{"policy": "long_lived", "baseEffectiveDays": 240, "supersedeAggressively": true}
	default:
		return map[string]any{"policy": "standard", "baseEffectiveDays": 90, "supersedeAggressively": false}
	}
}

// captureMetadata — mergeCaptureMetadata(undefined, req.metadata, extra)
// with the capture-derived fields. lifecycleStatus is always reset to
// "active" (mergeCaptureMetadata in TS).
func captureMetadata(req RememberRequest, action string, personalTerms []string) map[string]any {
	memType := InferMemoryType(req.Content, req.Namespace, req.Metadata)
	sensitivity := InferSensitivity(req.Content, req.Metadata, req.Sensitivity)
	confidence := 1.0
	if req.Confidence != nil {
		confidence = *req.Confidence
	}
	out := map[string]any{}
	for k, v := range req.Metadata {
		out[k] = v
	}
	out["lifecycleStatus"] = "active"
	out["memoryType"] = memType
	out["sensitivity"] = sensitivity
	out["worthiness"] = ScoreWorthiness(req.Content, memType, confidence, personalTerms)
	out["retention"] = RetentionPolicyFor(memType)
	out["captureAction"] = action
	return out
}
