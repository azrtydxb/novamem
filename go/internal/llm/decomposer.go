// Query decomposition + coherence rerank. Transcribed from
// packages/server/src/engine/query-decomposer.ts; both prompts are copied
// VERBATIM.
//
// One LLM call rewrites a complex question into ≤N parallel sub-queries
// (the engine retrieves per sub-query and unions). A second, optional
// call reranks the unified candidate list for cross-memory coherence.
package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

func decompPrompt(q string, max int) string {
	return fmt.Sprintf(`Rewrite this question into AT MOST %d short search queries that together cover all information needed to answer it. Each sub-query should target one distinct fact or relationship. Output ONLY a JSON array of strings.

Question: %s

Examples:
"How many items of clothing do I need to pick up or return?" → ["items the user needs to pick up","items the user needs to return","pending clothing items at stores"]
"What did I order last Tuesday?" → ["user order Tuesday"]
"When did I last visit a museum?" → ["user museum visit","last museum date"]

Output JSON array only, no prose:`, max, q)
}

func coherencePrompt(q string, memories []string) string {
	lines := make([]string, len(memories))
	for i, m := range memories {
		lines[i] = fmt.Sprintf("%d. %s", i+1, utf16Slice(m, 600))
	}
	return fmt.Sprintf(`Question: %s

Candidate memories (with rank prefix):
%s

Re-order these to maximize coherent support for the question. Drop memories that contradict the majority, are unrelated, or duplicate higher-ranked content. Output ONLY a JSON array of the rank numbers (1-indexed) in the new order, e.g. [3,1,4]. No prose:`, q, strings.Join(lines, "\n"))
}

// QueryDecomposerConfig — query-decomposer.ts QueryDecomposerConfig.
type QueryDecomposerConfig struct {
	Config
	MaxSubqueries   int
	CoherenceRerank bool
}

type QueryDecomposer struct {
	client
	cfg QueryDecomposerConfig
}

func NewQueryDecomposer(cfg QueryDecomposerConfig) *QueryDecomposer {
	return &QueryDecomposer{client: newClient(cfg.Config), cfg: cfg}
}

// Decompose returns the original query + ≤(maxSubqueries) rewrites, the
// original always first and verbatim so a degenerate decomposition can't
// cripple retrieval. Dedupes case-insensitively.
func (d *QueryDecomposer) Decompose(ctx context.Context, query string) ([]string, error) {
	orig := strings.TrimSpace(query)
	if orig == "" {
		return nil, nil
	}
	text, err := d.complete(ctx, "decompose", []Message{
		{Role: "user", Content: decompPrompt(orig, d.cfg.MaxSubqueries)},
	}, 256)
	if errors.Is(err, errNotOK) {
		return []string{orig}, nil
	}
	if err != nil {
		return nil, err
	}
	all := append([]string{orig}, parseStringArray(text)...)
	var dedup []string
	seen := map[string]bool{}
	for _, q := range all {
		k := strings.ToLower(q)
		if seen[k] {
			continue
		}
		seen[k] = true
		dedup = append(dedup, q)
		if len(dedup) >= d.cfg.MaxSubqueries+1 {
			break
		}
	}
	return dedup, nil
}

// CoherenceRerank returns a permutation of the candidate indexes (0-based)
// or nil when the pass is disabled, the input is too short, or the model
// gave nothing usable. Candidates missing from the model's answer are
// appended in their original order (stable fallback).
func (d *QueryDecomposer) CoherenceRerank(ctx context.Context, query string, candidates []string) ([]int, error) {
	if !d.cfg.CoherenceRerank || len(candidates) < 2 {
		return nil, nil
	}
	// One rank number per candidate, plus JSON punctuation.
	maxTokens := len(candidates)*6 + 64
	if maxTokens < 200 {
		maxTokens = 200
	}
	text, err := d.complete(ctx, "coherenceRerank", []Message{
		{Role: "user", Content: coherencePrompt(query, candidates)},
	}, maxTokens)
	if errors.Is(err, errNotOK) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ranks := parseNumberArray(text) // 1-indexed from the prompt
	if len(ranks) == 0 {
		return nil, nil
	}
	var order []int
	seen := map[int]bool{}
	for _, r := range ranks {
		idx := r - 1
		if idx >= 0 && idx < len(candidates) && !seen[idx] {
			order = append(order, idx)
			seen[idx] = true
		}
	}
	for i := range candidates {
		if !seen[i] {
			order = append(order, i)
		}
	}
	return order, nil
}

func parseStringArray(raw string) []string {
	match := firstJSONArray(stripJSONFences(raw))
	if match == "" {
		return nil
	}
	var arr []any
	if err := json.Unmarshal([]byte(match), &arr); err != nil {
		return nil
	}
	var out []string
	for _, x := range arr {
		s, ok := x.(string)
		if !ok {
			continue
		}
		if v := strings.TrimSpace(s); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func parseNumberArray(raw string) []int {
	match := firstJSONArray(stripJSONFences(raw))
	if match == "" {
		return nil
	}
	var arr []any
	if err := json.Unmarshal([]byte(match), &arr); err != nil {
		return nil
	}
	var out []int
	for _, x := range arr {
		n, ok := x.(float64)
		if !ok || math.IsNaN(n) || math.IsInf(n, 0) {
			// Non-numbers become NaN in TS and are filtered out.
			continue
		}
		t := math.Trunc(n)
		if t < 1 {
			continue
		}
		out = append(out, int(t))
	}
	return out
}
