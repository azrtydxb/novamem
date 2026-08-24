// Package bench is the novamem benchmark harness: it runs a fixture of
// memories and queries through a retriever and reports retrieval
// quality, answer quality, safety and latency.
//
// Ported from packages/benchmarks (TypeScript) per ADR 0004, which
// chose a single Go harness over the previous TS + Python split. The
// report shape is a contract — docs/benchmarks/ numbers were produced
// in it — so the JSON field order and semantics match the TypeScript
// original, pinned by testdata/smoke-report.golden.json.
package bench

import "encoding/json"

// Memory is one stored item a query can retrieve.
type Memory struct {
	ID           string         `json:"id"`
	Text         string         `json:"text"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	SupersededBy string         `json:"supersededBy,omitempty"`
}

// Query is one benchmark question.
type Query struct {
	QueryID            string   `json:"queryId"`
	Text               string   `json:"text"`
	Category           string   `json:"category,omitempty"`
	ExpectedAnswer     string   `json:"expectedAnswer,omitempty"`
	RelevantMemoryIDs  []string `json:"relevantMemoryIds"`
	ForbiddenMemoryIDs []string `json:"forbiddenMemoryIds,omitempty"`
}

// Fixture is a benchmark corpus plus its queries.
type Fixture struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Version     string `json:"version"`
	Description string `json:"description,omitempty"`
	// Source is free-form provenance: the smoke fixture carries an
	// object, others a bare string, so it is kept as raw JSON.
	Source   json.RawMessage `json:"source,omitempty"`
	Memories []Memory        `json:"memories"`
	Queries  []Query         `json:"queries"`
}

// Retrieved is one hit, with the score that ranked it.
type Retrieved struct {
	ID     string
	Text   string
	Score  float64
	Answer string
}

// Retriever ranks a fixture's memories for one query. A live server
// retriever and the built-in lexical one are both this shape.
type Retriever func(q Query, f Fixture, k int) ([]Retrieved, error)

// Case is the per-query record the report carries.
type Case struct {
	QueryID        string   `json:"queryId"`
	Category       string   `json:"category,omitempty"`
	RelevantIDs    []string `json:"relevantIds"`
	ForbiddenIDs   []string `json:"forbiddenIds"`
	RetrievedIDs   []string `json:"retrievedIds"`
	Answer         string   `json:"answer,omitempty"`
	ExpectedAnswer string   `json:"expectedAnswer,omitempty"`
	LatencyMs      float64  `json:"latencyMs"`
}

// AtK is the metric block for one cutoff.
type AtK struct {
	Recall    float64 `json:"recall"`
	Precision float64 `json:"precision"`
	MRR       float64 `json:"mrr"`
	NDCG      float64 `json:"ndcg"`
}

// RetrievalReport is the metric block keyed by cutoff.
type RetrievalReport struct {
	QueryCount int            `json:"queryCount"`
	ByK        map[string]AtK `json:"byK"`
}

// AnswerReport scores the answers the retriever surfaced.
type AnswerReport struct {
	ExactMatch    float64 `json:"exactMatch"`
	TokenF1       float64 `json:"tokenF1"`
	AnsweredCount int     `json:"answeredCount"`
}

// SafetyReport is how often a forbidden memory reached the top-k.
type SafetyReport struct {
	ForbiddenHitRateAtK map[string]float64 `json:"forbiddenHitRateAtK"`
}

// LatencyReport summarises per-query wall time.
type LatencyReport struct {
	AverageMs float64 `json:"averageMs"`
	P95Ms     float64 `json:"p95Ms"`
	MaxMs     float64 `json:"maxMs"`
}

// FixtureSummary identifies the corpus a report was produced from.
type FixtureSummary struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Version     string `json:"version"`
	QueryCount  int    `json:"queryCount"`
	MemoryCount int    `json:"memoryCount"`
}

// Report is the harness's output. Field order is the JSON contract.
type Report struct {
	Fixture   FixtureSummary  `json:"fixture"`
	Retrieval RetrievalReport `json:"retrieval"`
	Answer    AnswerReport    `json:"answer"`
	Safety    SafetyReport    `json:"safety"`
	Latency   LatencyReport   `json:"latency"`
	Cases     []Case          `json:"cases"`
}
