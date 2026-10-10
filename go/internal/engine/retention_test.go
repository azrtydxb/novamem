package engine

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/azrtydxb/novamem/go/internal/coldstore"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
	"github.com/jackc/pgx/v5/pgxpool"
)

func retentionEngine(t *testing.T, user string) (*Engine, *warmstore.Store, *atomic.Int32, *map[string]bool) {
	t.Helper()
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a throwaway database to run")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	warm := warmstore.New(pool)
	if err := warmstore.Migrate(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	var coldDeletes, fakeColdRows atomic.Int32
	fakeVectors := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/collections" {
			_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"collections": []any{map[string]string{"name": "novamem_u_" + user + "_retention-test"}}}})
			return
		}
		if r.Method == http.MethodPost {
			coldDeletes.Add(1) // each fake vector deletion reaches the normal cold-store helper
			var req struct {
				Points []string `json:"points"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			for _, point := range req.Points {
				if fakeVectors[point] {
					delete(fakeVectors, point)
					fakeColdRows.Add(-1)
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{}, "status": "ok"})
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	cold := coldstore.NewQdrant(coldstore.Config{URL: server.URL, VectorSize: 3})
	t.Cleanup(cold.Close)
	return New(Options{Warm: warm, Cold: cold, Log: slog.New(slog.DiscardHandler)}), warm, &coldDeletes, &fakeVectors
}

func retentionTestPointID(id string) string {
	sum := sha1.Sum([]byte(id))
	h := hex.EncodeToString(sum[:])[:32]
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:])
}

func retentionInsert(t *testing.T, warm *warmstore.Store, user, id string, metadata map[string]any) {
	t.Helper()
	if _, err := warm.InsertEntry(context.Background(), id, warmstore.InsertEntryArgs{UserID: user, Namespace: "retention-test", Content: "retention test entry " + id, Metadata: metadata}); err != nil {
		t.Fatal(err)
	}
}

func TestApplyRetentionUsesUpdatedAtAndForgetCleanup(t *testing.T) {
	ctx := context.Background()
	stamp := time.Now().Format("150405.000000000")
	user := "retention-" + stamp
	e, warm, coldDeletes, fakeVectors := retentionEngine(t, user)
	old, updated, ttl, recent, factID := "OLD"+stamp, "UPDATED"+stamp, "TTL"+stamp, "RECENT"+stamp, "FACT"+stamp
	retentionInsert(t, warm, user, old, nil)
	retentionInsert(t, warm, user, updated, nil)
	retentionInsert(t, warm, user, ttl, map[string]any{"expiresAt": time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)})
	retentionInsert(t, warm, user, recent, nil)
	retentionInsert(t, warm, user, factID, map[string]any{"source_chunk_id": old, "fact": map[string]any{"object": "fixture"}})
	for _, id := range []string{old, updated, ttl, recent, factID} {
		(*fakeVectors)[retentionTestPointID(id)] = true
	}
	// Keep this test repeatable even on a shared throwaway database.
	ids := []string{old, updated, ttl, recent, factID}
	t.Cleanup(func() {
		for _, id := range ids {
			_, _ = warm.Pool.Exec(context.Background(), `DELETE FROM memory_entries WHERE id=$1`, id)
		}
	})
	if _, err := warm.Pool.Exec(ctx, `UPDATE memory_entries SET updated_at=now()-interval '40 days' WHERE id=ANY($1::text[])`, []string{old, ttl}); err != nil {
		t.Fatal(err)
	}
	if _, err := warm.Pool.Exec(ctx, `UPDATE memory_entries SET created_at=now()-interval '90 days', updated_at=now()-interval '2 days' WHERE id=$1`, updated); err != nil {
		t.Fatal(err)
	}
	if _, err := warm.Pool.Exec(ctx, `UPDATE memory_entries SET updated_at=now()-interval '2 days' WHERE id=$1`, recent); err != nil {
		t.Fatal(err)
	}
	r, err := e.ApplyRetention(ctx, 30*24*time.Hour, 20, false)
	if err != nil {
		t.Fatal(err)
	}
	if r.Deleted < 1 {
		t.Fatalf("deleted %d test entries, want the old source deleted", r.Deleted)
	}
	if coldDeletes.Load() < 2 || (*fakeVectors)[retentionTestPointID(old)] || (*fakeVectors)[retentionTestPointID(factID)] || len(*fakeVectors) != 3 {
		t.Errorf("cold delete calls=%d fake vectors remaining=%d, want source and derived fact removed", coldDeletes.Load(), len(*fakeVectors))
	}
	for _, id := range []string{old, factID} {
		entry, err := warm.GetEntry(ctx, user, id, nil)
		if err != nil {
			t.Fatal(err)
		}
		if entry != nil {
			t.Errorf("%s survived retention", id)
		}
		var fts int
		if err := warm.Pool.QueryRow(ctx, `SELECT count(*) FROM memory_fts WHERE entry_id=$1`, id).Scan(&fts); err != nil {
			t.Fatal(err)
		}
		if fts != 0 {
			t.Errorf("%s left %d FTS rows", id, fts)
		}
	}
	for _, id := range []string{updated, ttl, recent} {
		entry, err := warm.GetEntry(ctx, user, id, nil)
		if err != nil {
			t.Fatal(err)
		}
		if entry == nil {
			t.Errorf("%s was incorrectly deleted", id)
		}
	}
}

func TestApplyRetentionDryRunAndDisabledEquivalent(t *testing.T) {
	ctx := context.Background()
	stamp := time.Now().Format("150405.000000000")
	user, id := "retention-dry-"+stamp, "DRY"+stamp
	e, warm, coldDeletes, fakeVectors := retentionEngine(t, user)
	retentionInsert(t, warm, user, id, nil)
	(*fakeVectors)[retentionTestPointID(id)] = true
	t.Cleanup(func() { _, _ = warm.Pool.Exec(context.Background(), `DELETE FROM memory_entries WHERE id=$1`, id) })
	if _, err := warm.Pool.Exec(ctx, `UPDATE memory_entries SET updated_at=now()-interval '90 days' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	r, err := e.ApplyRetention(ctx, 30*24*time.Hour, 10, true)
	if err != nil {
		t.Fatal(err)
	}
	if !r.DryRun || r.Selected < 1 || r.Deleted != 0 {
		t.Fatalf("unexpected dry-run result: %+v", r)
	}
	found := false
	for _, candidateID := range r.EntryIDs {
		if candidateID == id {
			found = true
		}
	}
	if !found {
		t.Errorf("dry-run did not report candidate %s: %+v", id, r.EntryIDs)
	}
	entry, err := warm.GetEntry(ctx, user, id, nil)
	if err != nil {
		t.Fatal(err)
	}
	if entry == nil {
		t.Fatal("dry-run deleted the candidate")
	}
	if coldDeletes.Load() != 0 {
		t.Fatal("dry-run called cold deletion")
	}
	if !(*fakeVectors)[retentionTestPointID(id)] {
		t.Fatal("dry-run deleted the fake cold vector")
	}
	// Disabled mode is enforced by the scheduler, which does not start a loop.
	if entry == nil {
		t.Fatal("entry disappeared while retention was disabled")
	}
}

func TestApplyRetentionDryRunBatchIsOldestFirstAndBounded(t *testing.T) {
	ctx := context.Background()
	stamp := time.Now().Format("150405.000000000")
	user := "retention-order-" + stamp
	e, warm, _, _ := retentionEngine(t, user)
	ids := []string{"ORDER-A" + stamp, "ORDER-B" + stamp, "ORDER-C" + stamp}
	for _, id := range ids {
		retentionInsert(t, warm, user, id, nil)
	}
	t.Cleanup(func() {
		for _, id := range ids {
			_, _ = warm.Pool.Exec(context.Background(), `DELETE FROM memory_entries WHERE id=$1`, id)
		}
	})
	for i, age := range []int{90, 60, 40} {
		if _, err := warm.Pool.Exec(ctx, `UPDATE memory_entries SET updated_at=now()-$1::interval WHERE id=$2`, fmt.Sprintf("%d days", age), ids[i]); err != nil {
			t.Fatal(err)
		}
	}
	var oldest string
	if err := warm.Pool.QueryRow(ctx, `SELECT id FROM memory_entries WHERE updated_at <= now()-interval '30 days' AND metadata->>'expiresAt' IS NULL ORDER BY updated_at,id LIMIT 1`).Scan(&oldest); err != nil {
		t.Fatal(err)
	}
	r, err := e.ApplyRetention(ctx, 30*24*time.Hour, 1, true)
	if err != nil {
		t.Fatal(err)
	}
	if r.Selected != 1 || len(r.EntryIDs) != 1 || r.EntryIDs[0] != oldest {
		t.Fatalf("batch = %+v, want only oldest candidate %q", r, oldest)
	}
}
