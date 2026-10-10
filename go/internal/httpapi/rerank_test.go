package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/embeddings"
	"github.com/azrtydxb/novamem/go/internal/engine"
)

// DB-backed (see newOBOEnv). Proves the `rerank` field reaches the
// engine on every surface that runs a search: unset reranks, an
// explicit false does not.
func TestRerankFieldPassesThrough(t *testing.T) {
	var calls atomic.Int32
	rr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			Documents []string `json:"documents"`
		}
		_ = json.Unmarshal(raw, &body)
		rows := make([]map[string]any, len(body.Documents))
		for i := range rows {
			rows[i] = map[string]any{"index": i, "relevance_score": float64(i)}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": rows})
	}))
	defer rr.Close()
	e := newOBOEnvWith(t, func(o *engine.Options) {
		o.Reranker = embeddings.NewReranker(embeddings.RerankerConfig{Endpoint: rr.URL, Model: "m", TimeoutMs: 2000})
	})
	tok := e.register("acme").token(t, "bob")
	for _, c := range []string{"rerankprobe alpha one", "rerankprobe beta two", "rerankprobe gamma three"} {
		e.remember(tok, c, nil)
	}

	// delta runs fn and reports how many reranker calls it caused.
	delta := func(fn func()) int32 {
		before := calls.Load()
		fn()
		return calls.Load() - before
	}
	post := func(path string, body map[string]any) {
		t.Helper()
		if code, out := e.do("POST", path, tok, body); code != http.StatusOK {
			t.Fatalf("%s %v: %d %v", path, body, code, out)
		}
	}
	s := &server{engine: e.eng, warm: e.warm}
	tool := func(name string, args map[string]any) {
		t.Helper()
		if _, err := s.callTool(context.Background(), "org:acme/bob", name, args); err != nil {
			t.Fatalf("%s %v: %v", name, args, err)
		}
	}

	type surface struct {
		name string
		run  func(rerank any, set bool)
	}
	surfaces := []surface{
		{"POST /v1/search", func(v any, set bool) {
			b := map[string]any{"query": "rerankprobe"}
			if set {
				b["rerank"] = v
			}
			post("/v1/search", b)
		}},
		{"POST /v1/context", func(v any, set bool) {
			b := map[string]any{"message": "rerankprobe"}
			if set {
				b["rerank"] = v
			}
			post("/v1/context", b)
		}},
		{"MCP memory_search", func(v any, set bool) {
			b := map[string]any{"query": "rerankprobe"}
			if set {
				b["rerank"] = v
			}
			tool("memory_search", b)
		}},
		{"MCP memory_context", func(v any, set bool) {
			b := map[string]any{"message": "rerankprobe"}
			if set {
				b["rerank"] = v
			}
			tool("memory_context", b)
		}},
	}
	for _, sf := range surfaces {
		t.Run(sf.name, func(t *testing.T) {
			if n := delta(func() { sf.run(nil, false) }); n != 1 {
				t.Errorf("unset: %d reranker calls, want 1 (rerank by default)", n)
			}
			if n := delta(func() { sf.run(true, true) }); n != 1 {
				t.Errorf("rerank:true: %d reranker calls, want 1", n)
			}
			if n := delta(func() { sf.run(false, true) }); n != 0 {
				t.Errorf("rerank:false: %d reranker calls, want 0 (opt-out)", n)
			}
		})
	}
}

// A non-boolean rerank is a validation error on every surface, not a
// silent ignore.
func TestRerankFieldRejectsNonBoolean(t *testing.T) {
	s := &server{}
	for _, tool := range []string{"memory_search", "memory_context"} {
		args := map[string]any{"query": "q", "message": "q", "rerank": "yes"}
		_, err := s.callTool(context.Background(), "public", tool, args)
		if err == nil || err.Error() != "invalid argument 'rerank': Invalid input: expected boolean, received string" {
			t.Fatalf("%s: %v", tool, err)
		}
	}
}
