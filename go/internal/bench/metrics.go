package bench

// Scoring, transcribed from packages/benchmarks/src/metrics.ts. The
// arithmetic order is preserved because published numbers were produced
// by it — see docs/benchmarks/.

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

var (
	articles    = regexp.MustCompile(`\b(a|an|the)\b`)
	nonAlnum    = regexp.MustCompile(`[^\p{L}\p{N}]+`)
	whitespaces = regexp.MustCompile(`\s+`)
)

// NormalizeAnswer lowercases, drops articles, strips punctuation, and
// collapses whitespace — SQuAD-style normalisation.
func NormalizeAnswer(input string) string {
	s := strings.ToLower(input)
	s = articles.ReplaceAllString(s, " ")
	s = nonAlnum.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	return whitespaces.ReplaceAllString(s, " ")
}

// ExactMatch is 1 when the normalised strings are identical.
func ExactMatch(predicted, expected string) float64 {
	if predicted == "" || expected == "" {
		return 0
	}
	if NormalizeAnswer(predicted) == NormalizeAnswer(expected) {
		return 1
	}
	return 0
}

// TokenF1 is the harmonic mean of token precision and recall, counting
// duplicate tokens only as often as they appear in the expectation.
func TokenF1(predicted, expected string) float64 {
	if predicted == "" || expected == "" {
		return 0
	}
	p := fields(NormalizeAnswer(predicted))
	e := fields(NormalizeAnswer(expected))
	if len(p) == 0 || len(e) == 0 {
		if len(p) == len(e) {
			return 1
		}
		return 0
	}
	counts := map[string]int{}
	for _, token := range e {
		counts[token]++
	}
	overlap := 0
	for _, token := range p {
		if counts[token] > 0 {
			overlap++
			counts[token]--
		}
	}
	if overlap == 0 {
		return 0
	}
	precision := float64(overlap) / float64(len(p))
	recall := float64(overlap) / float64(len(e))
	return (2 * precision * recall) / (precision + recall)
}

func fields(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, " ")
}

func dcg(gains []float64) float64 {
	sum := 0.0
	for i, rel := range gains {
		sum += rel / math.Log2(float64(i)+2)
	}
	return sum
}

// RetrievalCase is the slice of a Case the retrieval metrics need.
type RetrievalCase struct {
	QueryID      string
	RelevantIDs  []string
	RetrievedIDs []string
}

func evaluateAtK(cases []RetrievalCase, k int) AtK {
	var totals AtK
	for _, c := range cases {
		relevant := map[string]bool{}
		for _, id := range c.RelevantIDs {
			relevant[id] = true
		}
		top := c.RetrievedIDs
		if len(top) > k {
			top = top[:k]
		}
		gains := make([]float64, 0, len(top))
		seen := map[string]bool{}
		for _, id := range top {
			if relevant[id] && !seen[id] {
				seen[id] = true
				gains = append(gains, 1)
			} else {
				gains = append(gains, 0)
			}
		}
		hits := len(seen)
		if len(relevant) == 0 {
			totals.Recall += 1
		} else {
			totals.Recall += float64(hits) / float64(len(relevant))
		}
		if k != 0 {
			totals.Precision += float64(hits) / float64(k)
		}
		firstHit := -1
		for i, rel := range gains {
			if rel == 1 {
				firstHit = i
				break
			}
		}
		if firstHit >= 0 {
			totals.MRR += 1 / float64(firstHit+1)
		}
		idealHits := len(relevant)
		if k < idealHits {
			idealHits = k
		}
		ideal := make([]float64, k)
		for i := range ideal {
			if i < idealHits {
				ideal[i] = 1
			}
		}
		idealDcg := dcg(ideal)
		if idealDcg == 0 {
			totals.NDCG += 1
		} else {
			totals.NDCG += dcg(gains) / idealDcg
		}
	}
	n := float64(len(cases))
	if n < 1 {
		n = 1
	}
	return AtK{
		Recall:    totals.Recall / n,
		Precision: totals.Precision / n,
		MRR:       totals.MRR / n,
		NDCG:      totals.NDCG / n,
	}
}

// EvaluateRetrieval scores every cutoff in kValues.
func EvaluateRetrieval(cases []RetrievalCase, kValues []int) RetrievalReport {
	byK := map[string]AtK{}
	for _, k := range kValues {
		byK[itoa(k)] = evaluateAtK(cases, k)
	}
	return RetrievalReport{QueryCount: len(cases), ByK: byK}
}

// percentile matches the TypeScript helper: sort ascending, then index
// ceil(p/100 * n) - 1, clamped to the last element.
func percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	idx := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	if idx > len(sorted)-1 {
		idx = len(sorted) - 1
	}
	if idx < 0 {
		idx = 0
	}
	return sorted[idx]
}
