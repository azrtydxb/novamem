// Token-overlap and contradiction heuristics. Transcribed from
// engine/index.ts: contentTokens/JACCARD_STOPWORDS, jaccardOf,
// tokenJaccard, isContentSuperset, extractComparableScalars,
// hasExplicitNegation, looksContradictory.
package engine

import (
	"regexp"
	"strings"
)

var jaccardStopwords = map[string]bool{
	"a": true, "an": true, "the": true,
	"i": true, "you": true, "he": true, "she": true, "it": true, "we": true, "they": true,
	"me": true, "my": true, "your": true, "his": true, "her": true, "our": true, "their": true,
	"is": true, "are": true, "was": true, "were": true, "be": true, "been": true, "being": true, "am": true,
	"do": true, "does": true, "did": true, "have": true, "has": true, "had": true,
	"to": true, "of": true, "in": true, "on": true, "at": true, "by": true, "for": true, "from": true, "with": true, "as": true,
	"and": true, "or": true, "but": true, "if": true, "so": true, "than": true, "that": true, "this": true,
	"not": true, "no": true, "nor": true,
}

var wordRe = regexp.MustCompile(`[a-z0-9]+`)

// contentTokens — lowercased [a-z0-9]+ tokens minus stopwords.
func contentTokens(s string) map[string]bool {
	out := map[string]bool{}
	for _, t := range wordRe.FindAllString(strings.ToLower(s), -1) {
		if jaccardStopwords[t] {
			continue
		}
		out[t] = true
	}
	return out
}

func jaccardOf(a, b map[string]bool) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	intersect := 0
	for t := range a {
		if b[t] {
			intersect++
		}
	}
	union := len(a) + len(b) - intersect
	return float64(intersect) / float64(union)
}

// TokenJaccard — token-set Jaccard similarity, stopword-filtered.
func TokenJaccard(a, b string) float64 {
	return jaccardOf(contentTokens(a), contentTokens(b))
}

// IsContentSuperset — true when next carries every content word prev
// had, i.e. the new text restates/refines the old without dropping
// anything. Stricter than any similarity threshold on purpose: it is
// the only gate that distinguishes "same fact, said again" from
// "different fact, said the same way" (engine/index.ts doc-comment).
func IsContentSuperset(prev, next string) bool {
	a := contentTokens(prev)
	if len(a) == 0 {
		return true
	}
	b := contentTokens(next)
	for t := range a {
		if !b[t] {
			return false
		}
	}
	return true
}

var (
	scalarNumRe   = regexp.MustCompile(`\b\d+(\.\d+)?\b`)
	scalarVerRe   = regexp.MustCompile(`(?i)\bv?\d+(\.\d+)+\b`)
	scalarDateRe  = regexp.MustCompile(`\b\d{4}-\d{2}-\d{2}\b`)
	scalarPortRe  = regexp.MustCompile(`(?i)\b(?:port|:|endpoint\s+[^\s:]+:)\s*(\d{2,5})\b`)
	scalarShaRe   = regexp.MustCompile(`(?i)\bsha[-_:]?[a-z0-9]{6,}\b`)
	scalarModelRe = regexp.MustCompile(`(?i)\bmodel\s+([a-z0-9._/-]+)\b`)
	scalarImageRe = regexp.MustCompile(`(?i)\b(?:image|container)\s+([a-z0-9._/:-]+)\b`)
	negationRe    = regexp.MustCompile(`(?i)\b(no|not|never|disabled|inactive|false|off|without|stopped|removed|deprecated)\b`)
)

func extractComparableScalars(content string) map[string]bool {
	out := map[string]bool{}
	for _, m := range scalarNumRe.FindAllString(content, -1) {
		out["num:"+m] = true
	}
	for _, m := range scalarVerRe.FindAllString(content, -1) {
		out["ver:"+strings.ToLower(m)] = true
	}
	for _, m := range scalarDateRe.FindAllString(content, -1) {
		out["date:"+m] = true
	}
	for _, m := range scalarPortRe.FindAllStringSubmatch(content, -1) {
		out["port:"+m[1]] = true
	}
	for _, m := range scalarShaRe.FindAllString(content, -1) {
		out["sha:"+strings.ToLower(m)] = true
	}
	for _, m := range scalarModelRe.FindAllStringSubmatch(content, -1) {
		if m[1] != "" {
			out["model:"+strings.ToLower(m[1])] = true
		}
	}
	for _, m := range scalarImageRe.FindAllStringSubmatch(content, -1) {
		if m[1] != "" {
			out["image:"+strings.ToLower(m[1])] = true
		}
	}
	return out
}

func hasExplicitNegation(content string) bool {
	return negationRe.MatchString(content)
}

// LooksContradictory — comparable scalars differ on both sides, or the
// negation polarity flipped (engine/index.ts looksContradictory).
func LooksContradictory(oldContent, newContent string) bool {
	oldScalars := extractComparableScalars(oldContent)
	newScalars := extractComparableScalars(newContent)
	if len(oldScalars) > 0 && len(newScalars) > 0 {
		oldOnly, newOnly := false, false
		for v := range oldScalars {
			if !newScalars[v] {
				oldOnly = true
				break
			}
		}
		for v := range newScalars {
			if !oldScalars[v] {
				newOnly = true
				break
			}
		}
		if oldOnly && newOnly {
			return true
		}
	}
	return hasExplicitNegation(oldContent) != hasExplicitNegation(newContent)
}
