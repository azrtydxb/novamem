package conformance

// Port of suites/10-data-plane.test.ts.

import (
	"testing"
	"time"
)

// The TS describe block threads shared state (the created entry id, and
// the list of ids to clean up) across its cases, so the port is one Test
// function with ordered subtests.
func TestDataPlaneCRUD(t *testing.T) {
	Target(t)
	ns := NS()
	var id string
	var createdIds []string

	t.Cleanup(func() {
		// No bulk forget-by-namespace endpoint exists (only POST /v1/forget by
		// id) — loop over everything this suite created that wasn't already
		// forgotten above.
		for _, entryID := range createdIds {
			if entryID == id {
				continue
			}
			_, _ = apiE("/v1/forget", Opts{Body: map[string]any{"id": entryID}})
		}
	})

	t.Run("remember stores and returns an entry id", func(t *testing.T) {
		r := API(t, "/v1/remember", Opts{
			Body: map[string]any{"content": "conformance fact " + ns, "namespace": ns},
		})
		if r.Status != 201 {
			t.Fatalf("status = %d, want 201", r.Status)
		}
		parsed := r.MustValidate(t, RememberResponse)
		got, _ := parsed["id"].(string)
		if got == "" {
			t.Fatalf("id = %v, want truthy", parsed["id"])
		}
		id = got
		createdIds = append(createdIds, id)
	})

	t.Run("recent lists it", func(t *testing.T) {
		if id == "" {
			t.Fatal("no entry id from the remember subtest")
		}
		r := API(t, "/v1/recent", Opts{Body: map[string]any{"namespace": ns, "k": 10}})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		parsed := r.MustValidate(t, RecentResponse)
		found := false
		for _, e := range parsed["results"].([]any) {
			if err := Validate(e, MemoryEntry); err != nil {
				t.Fatalf("entry shape: %v", err)
			}
			if e.(map[string]any)["id"] == id {
				found = true
			}
		}
		if !found {
			t.Fatalf("recent does not list %s", id)
		}
	})

	t.Run("PUT /v1/memories/:id updates content; recent reflects the change", func(t *testing.T) {
		if id == "" {
			t.Fatal("no entry id from the remember subtest")
		}
		newContent := "conformance fact " + ns + " (updated)"
		r := API(t, "/v1/memories/"+id, Opts{
			Method: "PUT",
			Body:   map[string]any{"content": newContent},
		})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		parsed := r.MustValidate(t, UpdateMemoryResponse)
		if parsed["id"] != id {
			t.Fatalf("id = %v, want %s", parsed["id"], id)
		}
		if parsed["updated"] != true {
			t.Fatalf("updated = %v, want true", parsed["updated"])
		}

		recent := API(t, "/v1/recent", Opts{Body: map[string]any{"namespace": ns, "k": 10}})
		if recent.Status != 200 {
			t.Fatalf("recent status = %d, want 200", recent.Status)
		}
		var updated map[string]any
		for _, e := range recent.MustValidate(t, RecentResponse)["results"].([]any) {
			if err := Validate(e, MemoryEntry); err != nil {
				t.Fatalf("entry shape: %v", err)
			}
			if m := e.(map[string]any); m["id"] == id {
				updated = m
			}
		}
		if updated == nil || updated["content"] != newContent {
			t.Fatalf("updated content = %v, want %q", updated, newContent)
		}
	})

	t.Run("remember with expiresAt honors TTL shape", func(t *testing.T) {
		r := API(t, "/v1/remember", Opts{
			Body: map[string]any{
				"content":   "ttl fact " + ns,
				"namespace": ns,
				"expiresAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
			},
		})
		if r.Status != 201 {
			t.Fatalf("status = %d, want 201", r.Status)
		}
		parsed := r.MustValidate(t, RememberResponse)
		got, _ := parsed["id"].(string)
		if got == "" {
			t.Fatalf("id = %v, want truthy", parsed["id"])
		}
		// Response shape carries no `expiresAt` echo (RememberResponse is just
		// `{id, rejected?, deduplicated?, embedded?}`) — the 201 + valid id is
		// the observable contract here.
		createdIds = append(createdIds, got)
	})

	t.Run("forget deletes; PUT on the forgotten id then 404s", func(t *testing.T) {
		if id == "" {
			t.Fatal("no entry id from the remember subtest")
		}
		del := API(t, "/v1/forget", Opts{Body: map[string]any{"id": id}})
		if del.Status != 200 {
			t.Fatalf("status = %d, want 200", del.Status)
		}
		parsed := del.MustValidate(t, ForgetResponse)
		if parsed["deleted"] != true {
			t.Fatalf("deleted = %v, want true", parsed["deleted"])
		}

		gone := API(t, "/v1/memories/"+id, Opts{
			Method: "PUT",
			Body:   map[string]any{"content": "should not apply"},
		})
		if gone.Status != 404 {
			t.Fatalf("status = %d, want 404", gone.Status)
		}
		gone.MustValidate(t, ErrorBody)
	})

	t.Run("stats responds with per-namespace counts", func(t *testing.T) {
		// The bench oracle's per-user stats scan can be slow under concurrent
		// suite load (observed >30s), well past vitest's default timeout —
		// give it real headroom rather than flaking the whole run. (The Go
		// httpClient's 11-minute ceiling already covers the 60s the TS case
		// asked for.)
		r := API(t, "/v1/stats", Opts{})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		r.MustValidate(t, StatsResponse)
	})
}
