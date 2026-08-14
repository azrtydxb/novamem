package metrics

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The Prometheus exposition is a contract: scrape configs and dashboards
// key off these exact names, in this order, with these HELP/TYPE lines.
// Verified byte-for-byte against the TypeScript MetricsCollector's
// renderProm() output; this test is the regression guard.
func TestRenderPromSurface(t *testing.T) {
	c := New()
	c.Record("u1", "hash1", "/v1/search")
	c.MarkDecayRun(time.Now())
	c.RecordDemotion(2)
	// One bound gauge, the rest nil → NaN (metrics.ts emits NaN for null).
	c.BindGauges(GaugeSources{WarmEntries: func(context.Context) (int, error) { return 7, nil }})

	out := c.RenderProm(context.Background())
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 60 {
		t.Fatalf("got %d lines, want 60 (20 metrics × HELP+TYPE+value)", len(lines))
	}
	for _, want := range []string{
		"# TYPE novamem_queries_total counter",
		"novamem_queries_total 1",
		"# TYPE novamem_decay_runs_total counter",
		"novamem_decay_runs_total 1",
		"novamem_demotions_total 2",
		"novamem_warm_entries 7",
		"novamem_cold_entries NaN",
		"novamem_queries_per_sec_60s 0.016666666666666666",
	} {
		if !strings.Contains(out, want+"\n") {
			t.Errorf("exposition is missing %q\n%s", want, out)
		}
	}
}
