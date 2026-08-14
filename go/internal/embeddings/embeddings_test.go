package embeddings

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestResolvePrefixes(t *testing.T) {
	cases := []struct {
		model    string
		query    string
		document string
		source   PrefixSource
	}{
		{"intfloat/e5-base-v2", "query: ", "passage: ", SourcePreset},
		{"intfloat/multilingual-e5-large", "query: ", "passage: ", SourcePreset},
		{"BAAI/bge-large-en-v1.5",
			"Represent this sentence for searching relevant passages: ", "", SourcePreset},
		// bge-m3 is trained without prefixes — deliberately no preset.
		{"BAAI/bge-m3", "", "", SourceNone},
		{"Qwen/Qwen3-Embedding-0.6B",
			"Instruct: Given a question or task from a user, retrieve stored memories " +
				"that contain the information needed to answer it\nQuery: ", "", SourcePreset},
		{"all-MiniLM-L6-v2", "", "", SourceNone},
	}
	for _, tc := range cases {
		p, source := ResolvePrefixesWithSource(tc.model, nil, nil)
		if p.Query != tc.query || p.Document != tc.document || source != tc.source {
			t.Fatalf("%s: got (%q,%q,%s), want (%q,%q,%s)",
				tc.model, p.Query, p.Document, source, tc.query, tc.document, tc.source)
		}
	}
	// Explicit override wins even when empty (an explicitly-set "" means
	// "no prefix", not "infer").
	empty := ""
	p, source := ResolvePrefixesWithSource("intfloat/e5-base-v2", &empty, nil)
	if source != SourceExplicit || p.Query != "" || p.Document != "" {
		t.Fatalf("explicit override: got (%q,%q,%s)", p.Query, p.Document, source)
	}
}

func TestCapInputs(t *testing.T) {
	texts, truncated := CapInputs([]string{"abcdef", "abc"}, 4)
	if truncated != 1 || texts[0] != "abcd" || texts[1] != "abc" {
		t.Fatalf("got %v truncated=%d", texts, truncated)
	}
	texts, truncated = CapInputs([]string{"abcdef"}, 0)
	if truncated != 0 || texts[0] != "abcdef" {
		t.Fatal("0 disables the cap")
	}
}

func newTestClient(t *testing.T, endpoint, model string) *Client {
	t.Helper()
	c, err := New(Config{
		Endpoint:   endpoint,
		Model:      model,
		APIKey:     "test-key",
		Dimensions: 3,
		TimeoutMs:  2000,
		Log:        slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestEmbedRequestShape(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1,0.2,0.3]}]}`))
	}))
	defer ts.Close()

	// Trailing slash on the endpoint is stripped; the "query" side of an
	// e5 model gets the "query: " prefix baked into the input.
	c := newTestClient(t, ts.URL+"/", "intfloat/e5-base-v2")
	vecs, err := c.Embed(context.Background(), []string{"hello"}, KindQuery)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/embeddings" {
		t.Fatalf("path %q, want /embeddings", gotPath)
	}
	if gotAuth != "Bearer test-key" {
		t.Fatalf("auth %q", gotAuth)
	}
	if gotBody["model"] != "intfloat/e5-base-v2" {
		t.Fatalf("model %v", gotBody["model"])
	}
	inputs, _ := gotBody["input"].([]any)
	if len(inputs) != 1 || inputs[0] != "query: hello" {
		t.Fatalf("input %v, want [\"query: hello\"]", inputs)
	}
	if len(vecs) != 1 || len(vecs[0]) != 3 || vecs[0][1] != 0.2 {
		t.Fatalf("vectors %v", vecs)
	}
	if c.ModelID() != "openai-compatible:intfloat/e5-base-v2" {
		t.Fatalf("modelID %q", c.ModelID())
	}
}

func TestEmbedNonRetryable4xx(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("bad model"))
	}))
	defer ts.Close()
	c := newTestClient(t, ts.URL, "m")
	_, err := c.Embed(context.Background(), []string{"x"}, KindDocument)
	if err == nil || !strings.Contains(err.Error(), "embeddings http 400: bad model") {
		t.Fatalf("err %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("4xx must fail fast: %d calls", calls.Load())
	}
}

func TestEmbedRetriesOn5xx(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"embedding":[1]}]}`))
	}))
	defer ts.Close()
	c := newTestClient(t, ts.URL, "m")
	vecs, err := c.Embed(context.Background(), []string{"x"}, KindDocument)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 || len(vecs) != 1 {
		t.Fatalf("calls=%d vecs=%v", calls.Load(), vecs)
	}
}

func TestEmbedExhaustsRetries(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer ts.Close()
	c := newTestClient(t, ts.URL, "m")
	_, err := c.Embed(context.Background(), []string{"x"}, KindDocument)
	if err == nil {
		t.Fatal("want error after exhausted retries")
	}
	if calls.Load() != 3 {
		t.Fatalf("want 3 attempts, got %d", calls.Load())
	}
}

func TestRerank(t *testing.T) {
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		// index 5 is out of range and must be ignored; index 1 scores.
		_, _ = w.Write([]byte(`{"results":[{"index":1,"relevance_score":0.9},{"index":5,"relevance_score":0.1}]}`))
	}))
	defer ts.Close()
	r := NewReranker(RerankerConfig{Endpoint: ts.URL, Model: "bge-reranker-v2-m3", TimeoutMs: 2000})
	scores, err := r.Rerank(context.Background(), "q", []string{"doc a", "doc b"})
	if err != nil {
		t.Fatal(err)
	}
	if gotBody["model"] != "bge-reranker-v2-m3" || gotBody["query"] != "q" {
		t.Fatalf("body %v", gotBody)
	}
	if scores[0] != nil {
		t.Fatal("unscored index must stay nil")
	}
	if scores[1] == nil || *scores[1] != 0.9 {
		t.Fatalf("scores[1] %v", scores[1])
	}
}

func TestRerankMissingResults(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer ts.Close()
	r := NewReranker(RerankerConfig{Endpoint: ts.URL, Model: "m", TimeoutMs: 2000})
	_, err := r.Rerank(context.Background(), "q", []string{"d"})
	if err == nil || !strings.Contains(err.Error(), "rerank response missing results[]") {
		t.Fatalf("err %v", err)
	}
}
