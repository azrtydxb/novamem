package bench

// Parity with the TypeScript harness this replaces (ADR 0004).
// testdata/smoke-report.golden.json is the report `pnpm bench:smoke`
// actually produced from testdata/novamem-recall-smoke.json, captured
// before packages/benchmarks is retired. Published numbers came out of
// that implementation, so reproducing it is the whole point of the port.
//
// Latency is EXCLUDED from the comparison: it is a measurement of the
// machine, not a result, and no two runs agree on it. Everything else —
// metrics, rankings, answers, safety, ordering — must match exactly.

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func loadFixture(t *testing.T) Fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/novamem-recall-smoke.json")
	if err != nil {
		t.Fatal(err)
	}
	var f Fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// stripLatency removes the timing fields so the comparison is about
// results only.
func stripLatency(t *testing.T, report any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	delete(m, "latency")
	cases, _ := m["cases"].([]any)
	for _, c := range cases {
		if cm, ok := c.(map[string]any); ok {
			delete(cm, "latencyMs")
		}
	}
	return m
}

func TestSmokeReportMatchesTypeScriptHarness(t *testing.T) {
	raw, err := os.ReadFile("testdata/smoke-report.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden map[string]any
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	delete(golden, "latency")
	if cases, ok := golden["cases"].([]any); ok {
		for _, c := range cases {
			if cm, ok := c.(map[string]any); ok {
				delete(cm, "latencyMs")
			}
		}
	}

	// The CLI's default cutoffs, which is what produced the fixture.
	got, err := Run(loadFixture(t), LexicalRetriever, []int{10, 20, 50, 200})
	if err != nil {
		t.Fatal(err)
	}
	mine := stripLatency(t, got)

	if !reflect.DeepEqual(golden, mine) {
		wantJSON, _ := json.MarshalIndent(golden, "", "  ")
		gotJSON, _ := json.MarshalIndent(mine, "", "  ")
		t.Fatalf("report differs from the TypeScript harness.\n--- want ---\n%s\n--- got ---\n%s", wantJSON, gotJSON)
	}
}

// The scoring helpers are the part every published number rests on, so
// they get their own cases rather than only being covered through a
// whole-report comparison.
func TestNormalizeAndScoring(t *testing.T) {
	if got := NormalizeAnswer("  The  ReefMat-1200!! "); got != "reefmat 1200" {
		t.Errorf("NormalizeAnswer = %q", got)
	}
	if got := ExactMatch("the ReefMat 1200", "ReefMat 1200"); got != 1 {
		t.Errorf("ExactMatch with an article = %v, want 1", got)
	}
	if got := ExactMatch("", "x"); got != 0 {
		t.Errorf("ExactMatch with an empty prediction = %v, want 0", got)
	}
	// Duplicate tokens count only as often as the expectation has them.
	// (Deliberately not using "a" here — it is an article, and
	// normalisation strips it before scoring.)
	if got := TokenF1("xx xx yy", "xx yy"); got < 0.79 || got > 0.81 {
		t.Errorf("TokenF1 = %v, want ~0.8", got)
	}
	if got := TokenF1("the reefmat", "reefmat"); got != 1 {
		t.Errorf("TokenF1 ignoring an article = %v, want 1", got)
	}
	if got := TokenF1("zzz", "a b"); got != 0 {
		t.Errorf("TokenF1 with no overlap = %v, want 0", got)
	}
}

func TestPercentileMatchesTypeScriptIndexing(t *testing.T) {
	values := []float64{10, 20, 30, 40}
	if got := percentile(values, 95); got != 40 {
		t.Errorf("p95 = %v, want 40", got)
	}
	if got := percentile(values, 50); got != 20 {
		t.Errorf("p50 = %v, want 20 (ceil(0.5*4)-1 = index 1)", got)
	}
	if got := percentile(nil, 95); got != 0 {
		t.Errorf("p95 of nothing = %v, want 0", got)
	}
}

// A superseded memory must never be retrievable: the fixture format uses
// it to model a fact that was replaced, and returning it is the failure
// the benchmark exists to catch.
func TestSupersededMemoriesAreNeverRetrieved(t *testing.T) {
	f := loadFixture(t)
	superseded := map[string]bool{}
	for _, m := range f.Memories {
		if m.SupersededBy != "" {
			superseded[m.ID] = true
		}
	}
	if len(superseded) == 0 {
		t.Skip("fixture has no superseded memories")
	}
	for _, q := range f.Queries {
		hits, err := LexicalRetriever(q, f, 200)
		if err != nil {
			t.Fatal(err)
		}
		for _, h := range hits {
			if superseded[h.ID] {
				t.Errorf("query %s retrieved superseded memory %s", q.QueryID, h.ID)
			}
		}
	}
}
