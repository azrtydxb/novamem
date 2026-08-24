// Package metrics is the in-process operational collector behind
// /v1/me/metrics, /v1/admin/metrics and /v1/admin/metrics/prom.
// Transcribed from packages/server/src/admin/metrics.ts: counters are
// monotonic and restart-reset by design, gauges are read-through to the
// stores at scrape time, rates come off a 60-second ring of event
// timestamps.
//
// It lives in its own package rather than inside httpapi because the
// engine records the lifecycle counters (decay runs, demotions, orphans
// reaped) and httpapi imports engine, not the other way round.
package metrics

import (
	"context"
	"fmt"
	"math"
	"runtime"
	"strconv"
	"sync"
	"time"
)

const rateWindow = 60 * time.Second

// Cap on distinct users / tokens held in memory (metrics.ts
// MAX_TRACKED_USERS / MAX_TRACKED_TOKENS), evicted least-recently-seen.
const maxTracked = 10_000

// Counters is the per-user counter block. The lifecycle counters
// (promotions/demotions/decay/orphans/errors) are global-only.
type Counters struct {
	Queries        int64 `json:"queries_total"`
	QueriesZeroHit int64 `json:"queries_zero_hit"`
	Remembers      int64 `json:"remembers_total"`
	Forgets        int64 `json:"forgets_total"`
	HitsWarm       int64 `json:"hits_warm_total"`
	HitsCold       int64 `json:"hits_cold_total"`
	HitsGraph      int64 `json:"hits_graph_total"`
}

// TokenCounters is the narrower per-token block /v1/me/metrics renders.
type TokenCounters struct {
	Queries   int64 `json:"queries_total"`
	Remembers int64 `json:"remembers_total"`
	Forgets   int64 `json:"forgets_total"`
}

type Rates struct {
	Queries   float64 `json:"queries_per_sec_60s"`
	Remembers float64 `json:"remembers_per_sec_60s"`
}

type TokenMetrics struct {
	TokenHash string        `json:"tokenHash"`
	Label     *string       `json:"label"`
	Counters  TokenCounters `json:"counters"`
	Rates     Rates         `json:"rates"`
}

type slot struct {
	counters Counters
	queries  []time.Time
	remember []time.Time
	// Pending counts since the last flush to metrics_samples. The rings
	// above are independent — they drive the live rate, not the history.
	pendingQueries   int
	pendingRemembers int
	seenAt           time.Time
}

// Sample is one per-user 1-minute throughput bucket for metrics_samples.
type Sample struct {
	UserID    string
	SampledAt time.Time
	Queries   int
	Remembers int
}

// GaugeSources are the read-through global gauges (main.ts
// bindGaugeSources). A nil member reports NaN/null.
type GaugeSources struct {
	WarmEntries       func(context.Context) (int, error)
	ColdEntries       func(context.Context) (int, error)
	GraphEdges        func(context.Context) (int, error)
	OrphansPending    func(context.Context) (int, error)
	PendingEmbeddings func(context.Context) (int, error)
	PendingFacts      func(context.Context) (int, error)
}

// UserGaugeSources are the per-user equivalents (/v1/me/metrics).
type UserGaugeSources struct {
	WarmEntries func(context.Context, string) (int, error)
	ColdEntries func(context.Context, string) (int, error)
}

// ponytail: one mutex for the whole collector — every operation is a map
// lookup plus a few adds. Shard only if it ever shows in a profile.
type Collector struct {
	mu        sync.Mutex
	startedAt time.Time
	users     map[string]*slot
	tokens    map[string]*slot

	global struct {
		promotions     int64
		demotions      int64
		decayRuns      int64
		orphansReaped  int64
		searchErrors   int64
		rememberErrors int64
	}
	lastDecayAt time.Time

	gauges     GaugeSources
	userGauges UserGaugeSources
}

func New() *Collector {
	return &Collector{startedAt: time.Now(), users: map[string]*slot{}, tokens: map[string]*slot{}}
}

func (c *Collector) BindGauges(g GaugeSources)         { c.gauges = g }
func (c *Collector) BindUserGauges(g UserGaugeSources) { c.userGauges = g }

// Record classifies one successful request by route path — the same
// mapping http.ts applies via recordQuery/recordRemember/recordForget.
func (c *Collector) Record(userID, tokenHash, path string) {
	kind := ""
	switch path {
	case "/v1/search", "/v1/recent", "/v1/neighbors", "/v1/context", "/v1/context-prefix":
		kind = "query"
	case "/v1/remember", "/v1/capture", "/v1/session-recap":
		kind = "remember"
	case "/v1/forget":
		kind = "forget"
	default:
		return
	}
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	bump := func(m map[string]*slot, key string) {
		s := c.slotLocked(m, key, now)
		switch kind {
		case "query":
			s.counters.Queries++
			s.queries = append(prune(s.queries, now), now)
			s.pendingQueries++
		case "remember":
			s.counters.Remembers++
			s.remember = append(prune(s.remember, now), now)
			s.pendingRemembers++
		case "forget":
			s.counters.Forgets++
		}
	}
	if userID != "" {
		bump(c.users, userID)
	}
	if tokenHash != "" {
		bump(c.tokens, tokenHash)
	}
}

func (c *Collector) slotLocked(m map[string]*slot, key string, now time.Time) *slot {
	s := m[key]
	if s == nil {
		evictOldest(m)
		s = &slot{}
		m[key] = s
	}
	s.seenAt = now
	return s
}

// evictOldest drops least-recently-seen entries until the map has room.
func evictOldest(m map[string]*slot) {
	for len(m) >= maxTracked {
		var oldestKey string
		var oldest time.Time
		for k, s := range m {
			if oldestKey == "" || s.seenAt.Before(oldest) {
				oldestKey, oldest = k, s.seenAt
			}
		}
		delete(m, oldestKey)
	}
}

func prune(ts []time.Time, now time.Time) []time.Time {
	cut := now.Add(-rateWindow)
	i := 0
	for i < len(ts) && ts[i].Before(cut) {
		i++
	}
	return ts[i:]
}

// ─── Global lifecycle counters ─────────────────────────────────────────

func (c *Collector) RecordPromotion(n int) { c.addGlobal(&c.global.promotions, int64(n)) }
func (c *Collector) RecordDemotion(n int)  { c.addGlobal(&c.global.demotions, int64(n)) }
func (c *Collector) RecordOrphansReaped(n int) {
	c.addGlobal(&c.global.orphansReaped, int64(n))
}
func (c *Collector) RecordSearchError()   { c.addGlobal(&c.global.searchErrors, 1) }
func (c *Collector) RecordRememberError() { c.addGlobal(&c.global.rememberErrors, 1) }

func (c *Collector) MarkDecayRun(at time.Time) {
	c.mu.Lock()
	c.global.decayRuns++
	c.lastDecayAt = at
	c.mu.Unlock()
}

func (c *Collector) addGlobal(p *int64, n int64) {
	if n == 0 {
		return
	}
	c.mu.Lock()
	*p += n
	c.mu.Unlock()
}

// ForgetToken drops a revoked token's counters (metrics.ts forgetToken).
func (c *Collector) ForgetToken(hash string) {
	c.mu.Lock()
	delete(c.tokens, hash)
	c.mu.Unlock()
}

// ─── Sample drain (persistent 24h throughput) ──────────────────────────

// DrainSamples takes the pending per-user counts and zeroes them.
func (c *Collector) DrainSamples(sampledAt time.Time) []Sample {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Sample
	for userID, s := range c.users {
		if s.pendingQueries == 0 && s.pendingRemembers == 0 {
			continue
		}
		out = append(out, Sample{UserID: userID, SampledAt: sampledAt, Queries: s.pendingQueries, Remembers: s.pendingRemembers})
		s.pendingQueries, s.pendingRemembers = 0, 0
	}
	return out
}

// RestoreSamples puts a failed flush's counts back (adding, since fresh
// traffic may have landed meanwhile) so the next tick retries them.
func (c *Collector) RestoreSamples(samples []Sample) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, s := range samples {
		slot := c.slotLocked(c.users, s.UserID, now)
		slot.pendingQueries += s.Queries
		slot.pendingRemembers += s.Remembers
	}
}

// ─── Snapshots ─────────────────────────────────────────────────────────

func (c *Collector) snapshotSlot(m map[string]*slot, key string, now time.Time) (Counters, Rates) {
	s := m[key]
	if s == nil {
		return Counters{}, Rates{}
	}
	sec := rateWindow.Seconds()
	return s.counters, Rates{
		Queries:   float64(len(prune(s.queries, now))) / sec,
		Remembers: float64(len(prune(s.remember, now))) / sec,
	}
}

// SnapshotForUser mirrors metrics.ts snapshotForUser: always emit a row
// per known token (zero-line for freshly minted ones).
func (c *Collector) SnapshotForUser(userID string, tokens []TokenMetrics, warmEntries, coldEntries *int) map[string]any {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	userCounters, userRates := c.snapshotSlot(c.users, userID, now)
	for i := range tokens {
		tc, tr := c.snapshotSlot(c.tokens, tokens[i].TokenHash, now)
		tokens[i].Counters = TokenCounters{Queries: tc.Queries, Remembers: tc.Remembers, Forgets: tc.Forgets}
		tokens[i].Rates = tr
	}
	return map[string]any{
		"userId":   userID,
		"counters": userCounters,
		"rates":    userRates,
		"gauges": map[string]any{
			"warm_entries": warmEntries,
			"cold_entries": coldEntries,
			// Per-user edge counts need a user-scoped graph query the TS
			// dashboard never got either (main.ts returns null).
			"graph_edges": nil,
		},
		"tokens":    tokens,
		"uptime_ms": now.Sub(c.startedAt).Milliseconds(),
	}
}

// Snapshot is the global admin view (metrics.ts MetricsSnapshot).
// Gauges resolve read-through; a failing source reports null, never an
// error — a broken gauge must not take the whole scrape down.
func (c *Collector) Snapshot(ctx context.Context) map[string]any {
	now := time.Now()
	c.mu.Lock()
	agg := Counters{}
	var qCount, rCount int
	for _, s := range c.users {
		agg.Queries += s.counters.Queries
		agg.QueriesZeroHit += s.counters.QueriesZeroHit
		agg.Remembers += s.counters.Remembers
		agg.Forgets += s.counters.Forgets
		agg.HitsWarm += s.counters.HitsWarm
		agg.HitsCold += s.counters.HitsCold
		agg.HitsGraph += s.counters.HitsGraph
		s.queries = prune(s.queries, now)
		s.remember = prune(s.remember, now)
		qCount += len(s.queries)
		rCount += len(s.remember)
	}
	g := c.global
	lastDecay := c.lastDecayAt
	c.mu.Unlock()

	read := func(f func(context.Context) (int, error)) *int {
		if f == nil {
			return nil
		}
		n, err := f(ctx)
		if err != nil {
			return nil
		}
		return &n
	}
	var lastDecayISO *string
	if !lastDecay.IsZero() {
		s := lastDecay.UTC().Format("2006-01-02T15:04:05.000Z")
		lastDecayISO = &s
	}
	sec := rateWindow.Seconds()
	return map[string]any{
		"counters": map[string]any{
			"queries_total":         agg.Queries,
			"queries_zero_hit":      agg.QueriesZeroHit,
			"remembers_total":       agg.Remembers,
			"forgets_total":         agg.Forgets,
			"hits_warm_total":       agg.HitsWarm,
			"hits_cold_total":       agg.HitsCold,
			"hits_graph_total":      agg.HitsGraph,
			"promotions_total":      g.promotions,
			"demotions_total":       g.demotions,
			"decay_runs_total":      g.decayRuns,
			"orphans_reaped_total":  g.orphansReaped,
			"search_errors_total":   g.searchErrors,
			"remember_errors_total": g.rememberErrors,
		},
		"gauges": map[string]any{
			"warm_entries":       read(c.gauges.WarmEntries),
			"cold_entries":       read(c.gauges.ColdEntries),
			"graph_edges":        read(c.gauges.GraphEdges),
			"orphans_pending":    read(c.gauges.OrphansPending),
			"pending_embeddings": read(c.gauges.PendingEmbeddings),
			"pending_facts":      read(c.gauges.PendingFacts),
			"last_decay_run_iso": lastDecayISO,
		},
		"rates": map[string]any{
			"queries_per_sec_60s":   float64(qCount) / sec,
			"remembers_per_sec_60s": float64(rCount) / sec,
		},
		"uptime_ms": now.Sub(c.startedAt).Milliseconds(),
	}
}

// UserWarmEntries / UserColdEntries expose the bound per-user gauges to
// the /v1/me/metrics handler; nil source or error → nil (renders "—").
func (c *Collector) UserWarmEntries(ctx context.Context, userID string) *int {
	return readUser(ctx, c.userGauges.WarmEntries, userID)
}

func (c *Collector) UserColdEntries(ctx context.Context, userID string) *int {
	return readUser(ctx, c.userGauges.ColdEntries, userID)
}

func readUser(ctx context.Context, f func(context.Context, string) (int, error), userID string) *int {
	if f == nil {
		return nil
	}
	n, err := f(ctx, userID)
	if err != nil {
		return nil
	}
	return &n
}

// RenderProm renders the global snapshot in Prometheus exposition
// format. The metric names, HELP/TYPE lines and their order are the
// contract (metrics.ts renderProm) — scrape configs and dashboards key
// off them, so this is a line-for-line transcription.
func (c *Collector) RenderProm(ctx context.Context) string {
	s := c.Snapshot(ctx)
	counters := s["counters"].(map[string]any)
	gauges := s["gauges"].(map[string]any)
	rates := s["rates"].(map[string]any)

	var b []byte
	emit := func(kind, name, help, value string) {
		b = append(b, "# HELP novamem_"+name+" "+help+"\n"...)
		b = append(b, "# TYPE novamem_"+name+" "+kind+"\n"...)
		b = append(b, "novamem_"+name+" "+value+"\n"...)
	}
	counter := func(name, help string, key string) {
		emit("counter", name, help, strconv.FormatInt(counters[key].(int64), 10))
	}
	// Prom has no null; NaN is the OpenMetrics convention metrics.ts uses.
	gauge := func(name, help string, value *int) {
		v := "NaN"
		if value != nil {
			v = strconv.Itoa(*value)
		}
		emit("gauge", name, help, v)
	}
	gaugeF := func(name, help string, value float64) {
		emit("gauge", name, help, formatFloat(value))
	}
	gi := func(key string) *int { v, _ := gauges[key].(*int); return v }

	counter("queries_total", "Total search queries", "queries_total")
	counter("queries_zero_hit_total", "Search queries returning no fused results", "queries_zero_hit")
	counter("remembers_total", "Memory entries stored", "remembers_total")
	counter("forgets_total", "Memory entries forgotten", "forgets_total")
	counter("hits_warm_total", "Search results contributed by the warm tier", "hits_warm_total")
	counter("hits_cold_total", "Search results contributed by the cold tier", "hits_cold_total")
	counter("hits_graph_total", "Search results contributed by the graph tier", "hits_graph_total")
	counter("promotions_total", "Cold→warm promotions", "promotions_total")
	counter("demotions_total", "Warm→cold demotions", "demotions_total")
	counter("decay_runs_total", "Decay loop ticks", "decay_runs_total")
	counter("orphans_reaped_total", "cold_orphans rows cleared", "orphans_reaped_total")
	gauge("warm_entries", "Current warm-tier entry count", gi("warm_entries"))
	gauge("cold_entries", "Current cold-tier entry count", gi("cold_entries"))
	gauge("graph_edges", "Current graph edge count (NaN if FalkorDB unreachable)", gi("graph_edges"))
	gauge("orphans_pending", "Pending cold_orphans rows", gi("orphans_pending"))
	gauge("pending_embeddings",
		"Entries stored with no vector yet (embedded_at IS NULL) — alert if this stops falling",
		gi("pending_embeddings"))
	gauge("pending_facts",
		"Chunks whose fact extraction has not completed (facts_pending_at IS NOT NULL) — alert if this stops falling",
		gi("pending_facts"))
	gaugeF("queries_per_sec_60s", "Rolling 60s queries/sec", rates["queries_per_sec_60s"].(float64))
	gaugeF("remembers_per_sec_60s", "Rolling 60s remembers/sec", rates["remembers_per_sec_60s"].(float64))
	gauge("uptime_seconds", "Process uptime (seconds)", intPtr(int(s["uptime_ms"].(int64)/1000)))

	// Go runtime section — appended after the novamem_* contract lines so
	// existing scrape configs and dashboards are unaffected. Added when Go
	// became the primary server (parity-audit item #16: no goroutine
	// visibility under soak).
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	rt := func(kind, name, help, value string) {
		b = append(b, "# HELP "+name+" "+help+"\n"...)
		b = append(b, "# TYPE "+name+" "+kind+"\n"...)
		b = append(b, name+" "+value+"\n"...)
	}
	rt("gauge", "go_goroutines", "Number of goroutines that currently exist", strconv.Itoa(runtime.NumGoroutine()))
	rt("gauge", "go_memstats_heap_alloc_bytes", "Bytes of allocated heap objects", strconv.FormatUint(ms.HeapAlloc, 10))
	rt("gauge", "go_memstats_heap_sys_bytes", "Bytes of heap memory obtained from the OS", strconv.FormatUint(ms.HeapSys, 10))
	rt("counter", "go_gc_cycles_total", "Completed GC cycles since process start", strconv.FormatUint(uint64(ms.NumGC), 10))
	return string(b)
}

func intPtr(n int) *int { return &n }

// formatFloat matches JS Number→string: integral values lose the ".0",
// everything else is shortest round-trip.
func formatFloat(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return fmt.Sprintf("%v", f)
}
