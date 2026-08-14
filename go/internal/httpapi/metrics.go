// Per-user / per-token request counters behind GET /v1/me/metrics.
// Shape transcribed from admin/metrics.ts snapshotForUser. This is the
// caller-facing slice only: the global admin snapshot, the Prometheus
// exposition and the sampler that persists metrics_samples rows are the
// admin plane / background-jobs slices.
//
// Classification happens in the auth middleware — one place, keyed on
// the route path, instead of a call in every handler.
package httpapi

import (
	"sync"
	"time"
)

const rateWindow = 60 * time.Second

type counters struct {
	Queries   int64 `json:"queries_total"`
	Remembers int64 `json:"remembers_total"`
	Forgets   int64 `json:"forgets_total"`
}

type slot struct {
	counters counters
	queries  []time.Time
	remember []time.Time
}

// ponytail: one mutex for the whole collector. Sharding only matters if
// this ever shows up in a profile — it is two map lookups per request.
type collector struct {
	mu        sync.Mutex
	startedAt time.Time
	users     map[string]*slot
	tokens    map[string]*slot
}

func newCollector() *collector {
	return &collector{startedAt: time.Now(), users: map[string]*slot{}, tokens: map[string]*slot{}}
}

func (c *collector) record(cl *caller, path string) {
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
		s := m[key]
		if s == nil {
			s = &slot{}
			m[key] = s
		}
		switch kind {
		case "query":
			s.counters.Queries++
			s.queries = append(prune(s.queries, now), now)
		case "remember":
			s.counters.Remembers++
			s.remember = append(prune(s.remember, now), now)
		case "forget":
			s.counters.Forgets++
		}
	}
	if cl.userID != "" {
		bump(c.users, cl.userID)
	}
	if cl.token != nil {
		bump(c.tokens, cl.token.TokenHash)
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

type rates struct {
	Queries   float64 `json:"queries_per_sec_60s"`
	Remembers float64 `json:"remembers_per_sec_60s"`
}

type tokenMetrics struct {
	TokenHash string   `json:"tokenHash"`
	Label     *string  `json:"label"`
	Counters  counters `json:"counters"`
	Rates     rates    `json:"rates"`
}

func (c *collector) snapshotSlot(m map[string]*slot, key string, now time.Time) (counters, rates) {
	s := m[key]
	if s == nil {
		return counters{}, rates{}
	}
	sec := rateWindow.Seconds()
	return s.counters, rates{
		Queries:   float64(len(prune(s.queries, now))) / sec,
		Remembers: float64(len(prune(s.remember, now))) / sec,
	}
}

// snapshotForUser mirrors admin/metrics.ts: always emit a row per known
// token (zero-line for freshly minted ones) so the UI can chart them.
func (c *collector) snapshotForUser(userID string, tokens []tokenMetrics, warmEntries *int) map[string]any {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	userCounters, userRates := c.snapshotSlot(c.users, userID, now)
	for i := range tokens {
		tokens[i].Counters, tokens[i].Rates = c.snapshotSlot(c.tokens, tokens[i].TokenHash, now)
	}
	return map[string]any{
		"userId":   userID,
		"counters": userCounters,
		"rates":    userRates,
		"gauges": map[string]any{
			"warm_entries": warmEntries,
			// Per-user cold/graph gauges need the cold tier's own
			// per-user counters — admin-plane slice.
			"cold_entries": nil,
			"graph_edges":  nil,
		},
		"tokens":    tokens,
		"uptime_ms": now.Sub(c.startedAt).Milliseconds(),
	}
}

// forgetToken drops a deleted token's counters (metrics.forgetToken).
func (c *collector) forgetToken(hash string) {
	c.mu.Lock()
	delete(c.tokens, hash)
	c.mu.Unlock()
}
