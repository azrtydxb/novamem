package bench

// The fixture runner and the built-in lexical retriever, transcribed
// from packages/benchmarks/src/runner.ts.

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

func itoa(n int) string { return strconv.Itoa(n) }

var termSplit = regexp.MustCompile(`[^\p{L}\p{N}]+`)

// terms is the retriever's tokenizer: lowercase, split on anything that
// is not a letter or digit, and keep tokens longer than two characters.
func terms(text string) map[string]bool {
	out := map[string]bool{}
	for _, t := range strings.Fields(termSplit.ReplaceAllString(strings.ToLower(text), " ")) {
		if len([]rune(t)) > 2 {
			out[t] = true
		}
	}
	return out
}

// LexicalRetriever is the dependency-free baseline: term overlap, with a
// large bonus when a memory literally contains the expected answer. It
// needs no model, which is what makes it usable as a CI smoke gate.
func LexicalRetriever(q Query, f Fixture, k int) ([]Retrieved, error) {
	qt := terms(q.Text)
	out := make([]Retrieved, 0, len(f.Memories))
	for _, m := range f.Memories {
		if m.SupersededBy != "" {
			continue
		}
		mt := terms(m.Text)
		overlap := 0
		for token := range qt {
			if mt[token] {
				overlap++
			}
		}
		containsAnswer := q.ExpectedAnswer != "" &&
			strings.Contains(strings.ToLower(m.Text), strings.ToLower(q.ExpectedAnswer))
		exactExpected := 0.0
		answer := ""
		if containsAnswer {
			exactExpected = 100
			answer = q.ExpectedAnswer
		}
		denom := len(qt)
		if denom < 1 {
			denom = 1
		}
		out = append(out, Retrieved{
			ID:     m.ID,
			Text:   m.Text,
			Score:  exactExpected + float64(overlap)/float64(denom),
			Answer: answer,
		})
	}
	// Score descending, id ascending — a stable order so a rerun of the
	// same fixture reports the same ranking.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > k {
		out = out[:k]
	}
	return out, nil
}

// Run executes every query through the retriever and scores the result.
func Run(f Fixture, retriever Retriever, kValues []int) (Report, error) {
	if len(kValues) == 0 {
		kValues = []int{1, 3, 5, 10}
	}
	maxK := kValues[0]
	for _, k := range kValues {
		if k > maxK {
			maxK = k
		}
	}

	cases := make([]Case, 0, len(f.Queries))
	for _, query := range f.Queries {
		started := time.Now()
		retrieved, err := retriever(query, f, maxK)
		if err != nil {
			return Report{}, err
		}
		latency := float64(time.Since(started).Nanoseconds()) / 1e6

		ids := make([]string, 0, len(retrieved))
		for _, r := range retrieved {
			ids = append(ids, r.ID)
		}
		answer := ""
		for _, r := range retrieved {
			if r.Answer != "" {
				answer = r.Answer
				break
			}
		}
		if answer == "" && len(retrieved) > 0 {
			answer = retrieved[0].Answer
		}
		forbidden := query.ForbiddenMemoryIDs
		if forbidden == nil {
			forbidden = []string{}
		}
		relevant := query.RelevantMemoryIDs
		if relevant == nil {
			relevant = []string{}
		}
		cases = append(cases, Case{
			QueryID:        query.QueryID,
			Category:       query.Category,
			RelevantIDs:    relevant,
			ForbiddenIDs:   forbidden,
			RetrievedIDs:   ids,
			Answer:         answer,
			ExpectedAnswer: query.ExpectedAnswer,
			LatencyMs:      latency,
		})
	}

	retrievalCases := make([]RetrievalCase, 0, len(cases))
	for _, c := range cases {
		retrievalCases = append(retrievalCases, RetrievalCase{
			QueryID: c.QueryID, RelevantIDs: c.RelevantIDs, RetrievedIDs: c.RetrievedIDs,
		})
	}

	var answered []Case
	for _, c := range cases {
		if c.ExpectedAnswer != "" {
			answered = append(answered, c)
		}
	}
	answer := AnswerReport{AnsweredCount: len(answered)}
	if len(answered) > 0 {
		var em, f1 float64
		for _, c := range answered {
			em += ExactMatch(c.Answer, c.ExpectedAnswer)
			f1 += TokenF1(c.Answer, c.ExpectedAnswer)
		}
		answer.ExactMatch = em / float64(len(answered))
		answer.TokenF1 = f1 / float64(len(answered))
	}

	forbiddenHit := map[string]float64{}
	for _, k := range kValues {
		if len(cases) == 0 {
			forbiddenHit[itoa(k)] = 0
			continue
		}
		hits := 0.0
		for _, c := range cases {
			forbidden := map[string]bool{}
			for _, id := range c.ForbiddenIDs {
				forbidden[id] = true
			}
			top := c.RetrievedIDs
			if len(top) > k {
				top = top[:k]
			}
			for _, id := range top {
				if forbidden[id] {
					hits++
					break
				}
			}
		}
		forbiddenHit[itoa(k)] = hits / float64(len(cases))
	}

	latencies := make([]float64, 0, len(cases))
	var sum, max float64
	for _, c := range cases {
		latencies = append(latencies, c.LatencyMs)
		sum += c.LatencyMs
		if c.LatencyMs > max {
			max = c.LatencyMs
		}
	}
	latency := LatencyReport{P95Ms: percentile(latencies, 95), MaxMs: max}
	if len(latencies) > 0 {
		latency.AverageMs = sum / float64(len(latencies))
	}

	return Report{
		Fixture: FixtureSummary{
			Name: f.Name, Kind: f.Kind, Version: f.Version,
			QueryCount: len(f.Queries), MemoryCount: len(f.Memories),
		},
		Retrieval: EvaluateRetrieval(retrievalCases, kValues),
		Answer:    answer,
		Safety:    SafetyReport{ForbiddenHitRateAtK: forbiddenHit},
		Latency:   latency,
		Cases:     cases,
	}, nil
}
