package metrics

// The cross-replica view. These counters are per-process and in-memory,
// so on kw's three replicas six consecutive reads of /v1/me/metrics
// returned decay_runs_total of 1/1/1/0/0/0 and three different
// last-decay timestamps — the dashboard reported whichever pod the
// request happened to land on.

import (
	"context"
	"testing"
	"time"
)

func countersOf(t *testing.T, snap map[string]any) map[string]any {
	t.Helper()
	c, ok := snap["counters"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot has no counters block: %v", snap)
	}
	return c
}

// TestSnapshotAddsSharedAndPendingCounters — the shared total plus this
// replica's unflushed delta.
//
// Adding the local delta is what stops an action you just performed from
// appearing to do nothing for up to a minute; it cannot double count,
// because the shared total only contains work that has been drained.
func TestSnapshotAddsSharedAndPendingCounters(t *testing.T) {
	c := New()
	c.BindShared(SharedSources{
		Counters: func(context.Context) (map[string]int64, error) {
			// Two sibling replicas have flushed four runs between them.
			return map[string]int64{"decay_runs_total": 4}, nil
		},
	})
	c.MarkDecayRun(time.Now()) // this replica, not yet flushed

	got := countersOf(t, c.Snapshot(context.Background()))["decay_runs_total"]
	if got != int64(5) {
		t.Errorf("decay_runs_total = %v, want 5 (4 shared + 1 pending here)", got)
	}

	// After a flush the delta belongs to the shared total, so counting it
	// locally again would double it.
	drained := c.DrainCounters()
	c.BindShared(SharedSources{
		Counters: func(context.Context) (map[string]int64, error) {
			return map[string]int64{"decay_runs_total": 5}, nil
		},
	})
	got = countersOf(t, c.Snapshot(context.Background()))["decay_runs_total"]
	if got != int64(5) {
		t.Errorf("after flushing, decay_runs_total = %v, want 5 — the drained "+
			"delta is in the shared total and must not be added twice", got)
	}
	if len(drained) == 0 {
		t.Error("DrainCounters returned nothing after a recorded run")
	}
}

// TestFailedFlushIsOfferedAgain — a dropped delta is a total that
// silently understates for ever, because nothing recomputes it.
func TestFailedFlushIsOfferedAgain(t *testing.T) {
	c := New()
	c.MarkDecayRun(time.Now())
	first := c.DrainCounters()
	if len(first) != 1 || first[0].Delta != 1 {
		t.Fatalf("first drain = %+v, want one delta of 1", first)
	}
	if again := c.DrainCounters(); len(again) != 0 {
		t.Fatalf("second drain = %+v, want nothing — it was already taken", again)
	}
	c.RestoreCounters(first)
	redo := c.DrainCounters()
	if len(redo) != 1 || redo[0].Delta != 1 {
		t.Errorf("after RestoreCounters, drain = %+v, want the delta offered again", redo)
	}
}

// TestSharedLastDecayWins — an in-memory timestamp reports "never" on
// every replica that has not personally run a sweep, which is
// indistinguishable from a sweep that is not running at all.
func TestSharedLastDecayWins(t *testing.T) {
	shared := time.Date(2026, 9, 12, 10, 27, 26, 0, time.UTC)
	c := New() // deliberately no local run recorded
	c.BindShared(SharedSources{
		LastDecayRun: func(context.Context) (*time.Time, error) { return &shared, nil },
	})
	g := c.Snapshot(context.Background())["gauges"].(map[string]any)
	iso, _ := g["last_decay_run_iso"].(*string)
	if iso == nil {
		t.Fatal("last_decay_run_iso is nil although a sibling replica ran a sweep")
	}
	if *iso != "2026-09-12T10:27:26.000Z" {
		t.Errorf("last_decay_run_iso = %q, want the shared timestamp", *iso)
	}
}

// TestSharedThroughputReplacesLocalRate — the rate tile described one
// pod's share of the traffic.
func TestSharedThroughputReplacesLocalRate(t *testing.T) {
	c := New()
	c.BindShared(SharedSources{
		Throughput: func(context.Context, time.Time) (int64, int64, error) {
			return 120, 60, nil // one minute of deployment-wide traffic
		},
	})
	rates := c.Snapshot(context.Background())["rates"].(map[string]any)
	if q := rates["queries_per_sec_60s"].(float64); q != 2 {
		t.Errorf("queries_per_sec_60s = %v, want 2 (120 over a 60s window)", q)
	}
	if r := rates["remembers_per_sec_60s"].(float64); r != 1 {
		t.Errorf("remembers_per_sec_60s = %v, want 1", r)
	}
}

// TestUnboundSharedFallsBackToLocal — a single-process run, and every
// unit test, must still see its own numbers.
func TestUnboundSharedFallsBackToLocal(t *testing.T) {
	c := New()
	c.MarkDecayRun(time.Now())
	if got := countersOf(t, c.Snapshot(context.Background()))["decay_runs_total"]; got != int64(1) {
		t.Errorf("decay_runs_total = %v, want the local 1 when nothing is bound", got)
	}
}
