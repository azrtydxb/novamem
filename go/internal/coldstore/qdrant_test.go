package coldstore

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// pointID must match cold-store.ts ulidToUuid: sha1 hex, first 32 chars,
// formatted 8-4-4-4-12.
func TestPointID(t *testing.T) {
	// sha1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
	if got, want := pointID("abc"), "a9993e36-4706-816a-ba3e-25717850c26c"; got != want {
		t.Fatalf("pointID = %q, want %q", got, want)
	}
}

func TestCollectionNaming(t *testing.T) {
	if got := collectionFor("alice", "default", nil); got != "novamem_u_alice_default" {
		t.Fatalf("user collection: %q", got)
	}
	p := "01PROJ"
	if got := collectionFor("alice", "default", &p); got != "novamem_p_01PROJ_default" {
		t.Fatalf("project collection: %q", got)
	}
	if got := legacyUserCollectionFor("alice", "default"); got != "novamem_alice_default" {
		t.Fatalf("legacy collection: %q", got)
	}
}

// End-to-end against a fake Qdrant: exercises lazy collection creation,
// the legacy-collection read union with per-entry dedupe (best score
// wins), delete fan-out across both collections, and the deleteAll
// prefix scan skipping a failing drop.
func TestQdrantStoreFlow(t *testing.T) {
	existing := map[string]bool{"novamem_alice_default": true} // legacy only
	var created, deletedPoints, droppedCollections []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			out := []map[string]string{}
			for n := range existing {
				out = append(out, map[string]string{"name": n})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"collections": out}})
		case r.Method == http.MethodPut && r.URL.Path == "/collections/novamem_u_alice_default":
			var body struct {
				Vectors struct {
					Size     int    `json:"size"`
					Distance string `json:"distance"`
				} `json:"vectors"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Vectors.Size != 3 || body.Vectors.Distance != "Cosine" {
				t.Errorf("createCollection vectors = %+v", body.Vectors)
			}
			created = append(created, r.URL.Path)
			existing["novamem_u_alice_default"] = true
			_, _ = w.Write([]byte(`{"result":true}`))
		case r.Method == http.MethodPut && r.URL.Path == "/collections/novamem_u_alice_default/points":
			_, _ = w.Write([]byte(`{"result":{"status":"completed"}}`))
		case r.URL.Path == "/collections/novamem_u_alice_default/points/query":
			// Primary holds the better copy of e1.
			_, _ = w.Write([]byte(`{"result":{"points":[
				{"id":"x","score":0.9,"payload":{"entryId":"e1"}},
				{"id":"y","score":-0.2,"payload":{"entryId":"e2"}}]}}`))
		case r.URL.Path == "/collections/novamem_alice_default/points/query":
			// Legacy holds a stale, lower-scored copy of e1.
			_, _ = w.Write([]byte(`{"result":{"points":[
				{"id":"x","score":0.4,"payload":{"entryId":"e1"}},
				{"id":"z","score":0.5,"payload":{"entryId":"e3"}}]}}`))
		case r.URL.Path == "/collections/novamem_u_alice_default/points/delete",
			r.URL.Path == "/collections/novamem_alice_default/points/delete":
			deletedPoints = append(deletedPoints, r.URL.Path)
			_, _ = w.Write([]byte(`{"result":{"status":"completed"}}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/collections/novamem_u_alice_broken":
			http.Error(w, `{"status":{"error":"boom"}}`, http.StatusInternalServerError)
		case r.Method == http.MethodDelete:
			droppedCollections = append(droppedCollections, r.URL.Path)
			delete(existing, r.URL.Path[len("/collections/"):])
			_, _ = w.Write([]byte(`{"result":true}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			http.Error(w, "no", http.StatusNotFound)
		}
	}))
	defer srv.Close()

	ctx := context.Background()
	s := newQdrant(Config{URL: srv.URL, VectorSize: 3})

	if !s.Ping(ctx) {
		t.Fatal("ping failed")
	}
	if err := s.Upsert(ctx, UpsertArgs{UserID: "alice", ID: "e1", Namespace: "default",
		Embedding: []float64{1, 0, 0}, Payload: map[string]any{"content": "hi"}}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if len(created) != 1 {
		t.Fatalf("expected lazy collection creation, got %v", created)
	}

	hits, err := s.Search(ctx, SearchArgs{UserID: "alice", Namespace: "default",
		Embedding: []float64{1, 0, 0}, K: 2})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("expected k=2 hits, got %d (%+v)", len(hits), hits)
	}
	if hits[0].ID != "e1" || hits[0].Score != 0.9 {
		t.Fatalf("best score per entry not kept: %+v", hits[0])
	}
	if hits[1].ID != "e3" || hits[1].Score != 0.5 {
		t.Fatalf("second hit: %+v", hits[1])
	}

	if err := s.Delete(ctx, "alice", "default", "e1", nil); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(deletedPoints) != 2 {
		t.Fatalf("delete must fan out to legacy too, got %v", deletedPoints)
	}

	// A failing drop is logged and skipped, not fatal.
	existing["novamem_u_alice_broken"] = true
	dropped, err := s.DeleteAllForUser(ctx, "alice")
	if err != nil {
		t.Fatalf("deleteAllForUser: %v", err)
	}
	if len(dropped) != 1 || dropped[0] != "novamem_u_alice_default" {
		t.Fatalf("dropped = %v", dropped)
	}
	_ = droppedCollections
}

func TestRetryClassification(t *testing.T) {
	retryable := &qdrantError{status: 500, body: `{"status":{"error":"Service internal error: Failed to apply operation to at least one of the shards. Please retry"}}`}
	if !isRetryableUpsertError(retryable) {
		t.Fatal("500 apply/retry must be retryable")
	}
	if isRetryableUpsertError(&qdrantError{status: 500, body: "something else"}) {
		t.Fatal("unrelated 500 must not be retryable")
	}
	if isRetryableUpsertError(&qdrantError{status: 400, body: "failed to apply operation, please retry"}) {
		t.Fatal("only 500 retries")
	}
	if !isCollectionAlreadyExists(&qdrantError{status: 409, body: ""}) {
		t.Fatal("409 is already-exists")
	}
	if !isCollectionAlreadyExists(&qdrantError{status: 400, body: `Collection \'x\' already exists!`}) {
		t.Fatal("message form is already-exists")
	}
	if isCollectionAlreadyExists(&qdrantError{status: 400, body: "bad vector size"}) {
		t.Fatal("unrelated 400 must not be swallowed")
	}
}
