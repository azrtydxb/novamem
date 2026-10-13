package engine

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/azrtydxb/novamem/go/internal/coldstore"
	"github.com/azrtydxb/novamem/go/internal/embeddings"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// newSignalEngine wires a real embeddings client and a real Qdrant client
// to fakes whose status codes the test controls, so a failure is
// attributable to exactly one dependency.
func newSignalEngine(t *testing.T, embedStatus, qdrantStatus int) (*Engine, *bytes.Buffer) {
	t.Helper()
	emb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if embedStatus != http.StatusOK {
			http.Error(w, "boom", embedStatus)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1,0.2,0.3]}]}`))
	}))
	t.Cleanup(emb.Close)
	qd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not found", qdrantStatus)
	}))
	t.Cleanup(qd.Close)

	client, err := embeddings.New(embeddings.Config{
		Endpoint: emb.URL, Model: "m", Log: slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	e := New(Options{
		Log:      slog.New(slog.NewTextHandler(&logs, nil)),
		Embedder: client,
		Cold:     coldstore.NewQdrant(coldstore.Config{URL: qd.URL, VectorSize: 3}),
	})
	clock := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return clock }
	return e, &logs
}

var signalRow = warmstore.PendingEntry{ID: "01ENTRY", UserID: "u", Namespace: "default", Content: "hello"}

func TestColdStoreFailureDoesNotMarkEmbedderFailing(t *testing.T) {
	e, logs := newSignalEngine(t, http.StatusOK, http.StatusNotFound)
	if err := e.embedAndUpsert(context.Background(), signalRow); err == nil {
		t.Fatal("expected the cold-store write to fail")
	}
	if e.embedderFailing() {
		t.Error("a healthy embedder was reported failing because the vector store rejected the write")
	}
	if !e.vectorStoreFailing() {
		t.Error("vector store failure was not signalled")
	}
	out := logs.String()
	if !strings.Contains(out, "vector store write failed") ||
		!strings.Contains(out, "op=reconcile") || !strings.Contains(out, "entryId=01ENTRY") {
		t.Errorf("missing vector-store log with op and entryId: %s", out)
	}
	if strings.Contains(out, "embedder failed") {
		t.Errorf("cold-store failure was logged as an embedder failure: %s", out)
	}
}

func TestEmbedFailureStillMarksEmbedderFailing(t *testing.T) {
	e, logs := newSignalEngine(t, http.StatusInternalServerError, http.StatusOK)
	if err := e.embedAndUpsert(context.Background(), signalRow); err == nil {
		t.Fatal("expected the embedding to fail")
	}
	if !e.embedderFailing() {
		t.Error("embedder failure was not signalled")
	}
	if e.vectorStoreFailing() {
		t.Error("an embedder failure must not mark the vector store failing")
	}
	out := logs.String()
	if !strings.Contains(out, "embedder failed") || strings.Contains(out, "vector store") {
		t.Errorf("wrong log for an embedding failure: %s", out)
	}
}

// Both signals throttle to one ERROR a minute and clear on the next success.
func TestFailureSignalsThrottleAndRecover(t *testing.T) {
	e, logs := newSignalEngine(t, http.StatusOK, http.StatusNotFound)
	for range 3 {
		_ = e.embedAndUpsert(context.Background(), signalRow)
	}
	if n := strings.Count(logs.String(), "vector store write failed"); n != 1 {
		t.Errorf("vector store failure logged %d times within a minute, want 1", n)
	}
	e.recordEmbedFailure(context.DeadlineExceeded, "search", "")
	e.recordEmbedFailure(context.DeadlineExceeded, "search", "")
	if n := strings.Count(logs.String(), "embedder failed"); n != 1 {
		t.Errorf("embedder failure logged %d times within a minute, want 1", n)
	}
	// The embedder's own throttle must not have been consumed by the store's.
	clock := e.now().Add(time.Second)
	e.now = func() time.Time { return clock }
	e.recordVectorStoreSuccess()
	e.recordEmbedSuccess()
	if e.vectorStoreFailing() || e.embedderFailing() {
		t.Error("a later success must clear the failing signal")
	}
}
