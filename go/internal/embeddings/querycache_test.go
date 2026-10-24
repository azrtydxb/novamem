package embeddings

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Concurrent and repeated identical queries cost one upstream call; documents
// are never cached; a failure is not remembered; callers cannot corrupt each
// other's vectors.
func TestQueryEmbeddingsAreSharedAndDocumentsAreNot(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1,0.2,0.3]}]}`))
	}))
	defer ts.Close()
	c := newTestClient(t, ts.URL, "bge-m3")

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Embed(context.Background(), []string{"same question"}, KindQuery); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	v, _ := c.Embed(context.Background(), []string{"same question"}, KindQuery)
	v[0][0] = 99 // a caller scribbling on its copy
	again, _ := c.Embed(context.Background(), []string{"same question"}, KindQuery)
	if calls.Load() != 1 || again[0][0] != 0.1 {
		t.Fatalf("upstream calls = %d, vector = %v", calls.Load(), again)
	}
	_, _ = c.Embed(context.Background(), []string{"same question"}, KindDocument)
	_, _ = c.Embed(context.Background(), []string{"same question"}, KindDocument)
	if calls.Load() != 3 {
		t.Fatalf("documents must not be cached: calls = %d", calls.Load())
	}
}

func TestQueryEmbeddingFailureIsNotCachedAndExpires(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"embedding":[1]}]}`))
	}))
	defer ts.Close()
	c := newTestClient(t, ts.URL, "bge-m3")
	if _, err := c.Embed(context.Background(), []string{"q"}, KindQuery); err == nil {
		t.Fatal("first call should fail")
	}
	if _, err := c.Embed(context.Background(), []string{"q"}, KindQuery); err != nil {
		t.Fatalf("a failure was cached: %v", err)
	}
	now := time.Now()
	c.queries.now = func() time.Time { return now.Add(defaultQueryCacheTTL + time.Second) }
	if _, err := c.Embed(context.Background(), []string{"q"}, KindQuery); err != nil || calls.Load() != 3 {
		t.Fatalf("expired entry not refetched: calls %d err %v", calls.Load(), err)
	}
}
