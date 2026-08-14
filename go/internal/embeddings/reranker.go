// Second-pass cross-encoder reranker client. Transcribed from
// packages/server/src/engine/reranker.ts (read-only reference). Wire
// format is the Jina/Cohere-compatible /rerank contract vLLM and TEI
// serve for models like BAAI/bge-reranker-v2-m3:
//
//	POST <endpoint>  {model, query, documents: string[]}
//	→ {results: [{index, relevance_score}, …]}
package embeddings

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

// maxDocChars — reranker.ts MAX_DOC_CHARS: documents are clipped before
// shipping; a cross-encoder scores the first window anyway.
const maxDocChars = 2000

type RerankerConfig struct {
	Endpoint  string // full URL — no path is appended
	Model     string
	APIKey    string
	TimeoutMs int
}

type Reranker struct {
	cfg  RerankerConfig
	http *http.Client
}

func NewReranker(cfg RerankerConfig) *Reranker {
	return &Reranker{cfg: cfg, http: &http.Client{}}
}

// Rerank scores documents against query. The result has one slot per
// input index; nil slots were not scored by the service (the caller
// keeps the fused order for those). Errors are transport/contract
// failures — the caller falls back to fused order, never fails the
// search (reranker.ts contract).
func (r *Reranker) Rerank(ctx context.Context, query string, documents []string) ([]*float64, error) {
	clipped := make([]string, len(documents))
	for i, d := range documents {
		clipped[i] = utf16Slice(d, maxDocChars)
	}
	body, err := json.Marshal(map[string]any{
		"model":     r.cfg.Model,
		"query":     query,
		"documents": clipped,
	})
	if err != nil {
		return nil, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(r.cfg.TimeoutMs)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, r.cfg.Endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	if r.cfg.APIKey != "" {
		req.Header.Set("authorization", "Bearer "+r.cfg.APIKey)
	}
	res, err := r.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close() //nolint:errcheck
	if res.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 200))
		return nil, fmt.Errorf("rerank endpoint %d: %s", res.StatusCode, string(detail))
	}
	var parsed struct {
		Results []struct {
			Index          *float64 `json:"index"`
			RelevanceScore *float64 `json:"relevance_score"`
		} `json:"results"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	if parsed.Results == nil {
		return nil, fmt.Errorf("rerank response missing results[]")
	}
	scores := make([]*float64, len(documents))
	for _, item := range parsed.Results {
		if item.Index == nil || item.RelevanceScore == nil {
			continue
		}
		idx := *item.Index
		// Integer, in range, finite score — reranker.ts validation.
		if idx != math.Trunc(idx) || idx < 0 || int(idx) >= len(documents) {
			continue
		}
		if math.IsNaN(*item.RelevanceScore) || math.IsInf(*item.RelevanceScore, 0) {
			continue
		}
		s := *item.RelevanceScore
		scores[int(idx)] = &s
	}
	return scores, nil
}
