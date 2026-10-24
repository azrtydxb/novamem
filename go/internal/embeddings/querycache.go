package embeddings

import (
	"context"
	"strings"
	"sync"
	"time"
)

// Query embeddings are cached for a short time and concurrent identical
// requests share one upstream call. A query vector depends only on the model
// and the text, never on who asked, so sharing it across callers leaks
// nothing; the cache lives in this process and is never persisted. It exists
// because a client that searches several scopes with the same question (one
// search per scope) otherwise pays one remote embedding round trip per scope.
const (
	defaultQueryCacheSize = 256
	defaultQueryCacheTTL  = 10 * time.Minute
)

type queryEntry struct {
	done chan struct{}
	vecs [][]float64
	err  error
	at   time.Time
}

type queryCache struct {
	mu  sync.Mutex
	max int
	ttl time.Duration
	m   map[string]*queryEntry
	now func() time.Time
}

func newQueryCache(max int, ttl time.Duration) *queryCache {
	return &queryCache{max: max, ttl: ttl, m: map[string]*queryEntry{}, now: time.Now}
}

// get returns the vectors for key, running fetch at most once for concurrent
// callers. A failed fetch is never cached; a caller whose leader failed runs
// its own fetch, so one caller's cancelled context does not fail the others.
func (c *queryCache) get(ctx context.Context, key string, fetch func() ([][]float64, error)) ([][]float64, error) {
	c.mu.Lock()
	if e, ok := c.m[key]; ok {
		select {
		case <-e.done:
			if e.err == nil && c.now().Sub(e.at) < c.ttl {
				c.mu.Unlock()
				return cloneVectors(e.vecs), nil
			}
			// Expired or failed: replaced below.
		default:
			c.mu.Unlock()
			select {
			case <-e.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			if e.err == nil {
				return cloneVectors(e.vecs), nil
			}
			return fetch()
		}
	}
	if len(c.m) >= c.max {
		c.evictLocked()
	}
	e := &queryEntry{done: make(chan struct{})}
	c.m[key] = e
	c.mu.Unlock()

	e.vecs, e.err = fetch()
	e.at = c.now()
	c.mu.Lock()
	if e.err != nil && c.m[key] == e {
		delete(c.m, key)
	}
	c.mu.Unlock()
	close(e.done)
	if e.err != nil {
		return nil, e.err
	}
	return cloneVectors(e.vecs), nil
}

// evictLocked drops expired entries, and one more when none had expired.
func (c *queryCache) evictLocked() {
	now := c.now()
	dropped := false
	for k, e := range c.m {
		select {
		case <-e.done:
			if now.Sub(e.at) >= c.ttl {
				delete(c.m, k)
				dropped = true
			}
		default:
		}
	}
	if dropped {
		return
	}
	for k, e := range c.m {
		select {
		case <-e.done:
			delete(c.m, k)
			return
		default:
		}
	}
}

func cloneVectors(v [][]float64) [][]float64 {
	out := make([][]float64, len(v))
	for i := range v {
		out[i] = append([]float64(nil), v[i]...)
	}
	return out
}

func queryKey(input []string) string { return strings.Join(input, "\x00") }
