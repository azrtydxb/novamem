package engine

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/embeddings"
)

// rerankFixture is an engine wired to an httptest reranker that scores
// documents by their position, last document highest, so a rerank
// reverses the fused order and a skipped one leaves it alone.
func rerankFixture(t *testing.T, status int) (*Engine, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if status != http.StatusOK {
			http.Error(w, "boom", status)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			Documents []string `json:"documents"`
		}
		_ = json.Unmarshal(raw, &body)
		type row struct {
			Index int     `json:"index"`
			Score float64 `json:"relevance_score"`
		}
		rows := make([]row, len(body.Documents))
		for i := range rows {
			rows[i] = row{Index: i, Score: float64(i)}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": rows})
	}))
	t.Cleanup(ts.Close)
	e := New(Options{
		Log: slog.New(slog.DiscardHandler),
		Reranker: embeddings.NewReranker(embeddings.RerankerConfig{
			Endpoint: ts.URL, Model: "m", TimeoutMs: 2000,
		}),
	})
	return e, &calls
}

func candidates(contents ...string) []*visibleItem {
	out := make([]*visibleItem, len(contents))
	for i, c := range contents {
		out[i] = &visibleItem{result: SearchResultItem{"content": c}}
	}
	return out
}

func order(v []*visibleItem) string {
	s := ""
	for _, it := range v {
		s += it.result["content"].(string)
	}
	return s
}

func ptr(b bool) *bool { return &b }

func TestRerankDefaultsOnWhenConfigured(t *testing.T) {
	cases := []struct {
		name      string
		rerank    *bool
		wantCalls int32
		wantOrder string
	}{
		{"unset reranks", nil, 1, "cba"},
		{"explicit true reranks", ptr(true), 1, "cba"},
		{"explicit false skips", ptr(false), 0, "abc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, calls := rerankFixture(t, http.StatusOK)
			v := candidates("a", "b", "c")
			e.rerankVisible(context.Background(), SearchArgs{Query: "q", Rerank: tc.rerank}, 10, v)
			if calls.Load() != tc.wantCalls {
				t.Fatalf("reranker calls = %d, want %d", calls.Load(), tc.wantCalls)
			}
			if got := order(v); got != tc.wantOrder {
				t.Fatalf("order = %q, want %q", got, tc.wantOrder)
			}
		})
	}
}

func TestRerankKeepsReturnedScoresMonotonic(t *testing.T) {
	e, _ := rerankFixture(t, http.StatusOK)
	v := candidates("a", "b", "c")
	for i, item := range v {
		item.score = float64(3 - i)
		item.result["score"] = item.score
	}
	// Decompose is enabled by the caller on this path; it changes candidate
	// retrieval but the final score invariant belongs to the rerank pass.
	e.rerankVisible(context.Background(), SearchArgs{Query: "q", Decompose: true}, 10, v)
	previous := float64(1 << 53)
	for _, item := range v {
		score := item.result["score"].(float64)
		if score > previous {
			t.Fatalf("scores are not non-increasing: %v then %v", previous, score)
		}
		if item.score != score {
			t.Fatalf("internal rank score %v does not match returned score %v", item.score, score)
		}
		previous = score
	}
}

func TestRerankNoRerankerNeverCalls(t *testing.T) {
	e := New(Options{Log: slog.New(slog.DiscardHandler)})
	for _, rr := range []*bool{nil, ptr(true), ptr(false)} {
		v := candidates("a", "b", "c")
		e.rerankVisible(context.Background(), SearchArgs{Query: "q", Rerank: rr}, 10, v)
		if got := order(v); got != "abc" {
			t.Fatalf("rerank=%v reordered without a reranker: %q", rr, got)
		}
	}
}

func TestRerankFailureKeepsFusedOrder(t *testing.T) {
	e, calls := rerankFixture(t, http.StatusInternalServerError)
	v := candidates("a", "b", "c")
	e.rerankVisible(context.Background(), SearchArgs{Query: "q"}, 10, v)
	if calls.Load() == 0 {
		t.Fatal("reranker was not attempted")
	}
	if got := order(v); got != "abc" {
		t.Fatalf("failed rerank changed the order: %q", got)
	}
}

func TestRerankSingleCandidateSkipped(t *testing.T) {
	e, calls := rerankFixture(t, http.StatusOK)
	e.rerankVisible(context.Background(), SearchArgs{Query: "q"}, 10, candidates("a"))
	if calls.Load() != 0 {
		t.Fatal("one candidate has nothing to reorder; the reranker must not be called")
	}
}
