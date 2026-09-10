package warmstore

import (
	"context"
	"testing"
	"time"
)

// Opt-in like the other DB tests:
//
//	NOVAMEM_TEST_DATABASE_URL=postgres://…/throwaway go test ./internal/warmstore
func insertDerived(t *testing.T, s *Store, ctx context.Context, userID, id, sourceID, ns string) {
	t.Helper()
	st := "fact"
	meta := map[string]any{"source_chunk_id": sourceID, "fact": map[string]any{"object": "x"}}
	if _, err := s.InsertEntry(ctx, id, InsertEntryArgs{
		UserID:     userID,
		Content:    "[fact] derived " + id,
		Namespace:  ns,
		Metadata:   meta,
		SourceType: &st,
	}); err != nil {
		t.Fatal(err)
	}
}

func insertSource(t *testing.T, s *Store, ctx context.Context, userID, id, ns string) {
	t.Helper()
	if _, err := s.InsertEntry(ctx, id, InsertEntryArgs{
		UserID:    userID,
		Content:   "source " + id,
		Namespace: ns,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteDerivedFactsRemovesOnlyThatSourcesFacts(t *testing.T) {
	a, _ := rateLimitStores(t) // reuses the opt-in DB harness
	ctx := context.Background()
	user := "u-" + time.Now().Format("150405.000000000")
	ns := "derived-test"
	src, other := "SRC"+user, "OTHER"+user

	insertSource(t, a, ctx, user, src, ns)
	insertSource(t, a, ctx, user, other, ns)
	insertDerived(t, a, ctx, user, "D1"+user, src, ns)
	insertDerived(t, a, ctx, user, "D2"+user, src, ns)
	insertDerived(t, a, ctx, user, "D3"+user, other, ns)

	got, err := a.DeleteDerivedFacts(ctx, user, src, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("deleted %d derived rows, want 2 (%+v)", len(got), got)
	}
	for _, d := range got {
		if d.Namespace != ns {
			t.Errorf("returned namespace %q, want %q — the caller needs it to drop the cold vector", d.Namespace, ns)
		}
	}
	// The other source's fact, and both sources, must survive.
	for _, id := range []string{"D3" + user, src, other} {
		e, err := a.GetEntry(ctx, user, id, nil)
		if err != nil {
			t.Fatal(err)
		}
		if e == nil {
			t.Errorf("%s was deleted but should have survived", id)
		}
	}
	// The shadow tables must go too. memory_fts is the one that bites:
	// keyword search reads it, so an orphan keeps returning an id whose
	// entry no longer exists.
	for _, tbl := range []struct{ name, col string }{
		{"memory_fts", "entry_id"},
		{"memory_access", "entry_id"},
	} {
		var n int
		if err := a.Pool.QueryRow(ctx,
			`SELECT count(*) FROM `+tbl.name+` WHERE `+tbl.col+` = ANY($1::text[])`,
			[]string{"D1" + user, "D2" + user}).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("%s still holds %d row(s) for the deleted derived entries", tbl.name, n)
		}
	}
	// And the surviving derived row keeps its shadow rows.
	var kept int
	if err := a.Pool.QueryRow(ctx,
		`SELECT count(*) FROM memory_fts WHERE entry_id = $1`, "D3"+user).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept == 0 {
		t.Error("another source's derived row lost its memory_fts entry")
	}

	// Idempotent: a second call finds nothing left.
	again, err := a.DeleteDerivedFacts(ctx, user, src, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Errorf("second call deleted %d more rows", len(again))
	}
}

// The back-link must never reach across users.
func TestDeleteDerivedFactsIsScopedToTheUser(t *testing.T) {
	a, _ := rateLimitStores(t)
	ctx := context.Background()
	stamp := time.Now().Format("150405.000000000")
	mine, theirs := "mine-"+stamp, "theirs-"+stamp
	src := "SHAREDID" + stamp

	insertDerived(t, a, ctx, mine, "MINE"+stamp, src, "ns")
	insertDerived(t, a, ctx, theirs, "THEIRS"+stamp, src, "ns")

	got, err := a.DeleteDerivedFacts(ctx, mine, src, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "MINE"+stamp {
		t.Fatalf("deleted %+v, want only this user's derived row", got)
	}
	e, err := a.GetEntry(ctx, theirs, "THEIRS"+stamp, nil)
	if err != nil {
		t.Fatal(err)
	}
	if e == nil {
		t.Error("another user's derived row was deleted")
	}
}
