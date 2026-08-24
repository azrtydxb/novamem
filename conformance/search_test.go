package conformance

// Port of suites/20-search.test.ts.
//
// Live oracle for this suite runs real embeddings (bge-m3 @
// http://192.168.10.125/v1) plus an extraction LLM on remember — seeding
// 8 entries triggers 8 real embedding calls, and indexing is async, so
// the seeding step polls /v1/recent until all seeded ids are visible
// before any search test runs. Differential runs against another oracle
// must pin the same embedding model or vector-signal assertions here
// (e.g. "espresso" ranking near "coffee machine") may not transfer.

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Eight-entry corpus with three separable topics (cluster infra, coffee,
// novamem storage internals) plus two unrelated distractors, so topical
// search has clear true positives and negatives to check against. All
// entries are substantive declarative facts — the worthiness gate
// (POST /v1/remember can return `id: null` + `rejected` for trivial
// content) rejects thin filler, so every string here carries a concrete
// subject + claim rather than a fragment.
//
// Base strings are templated with the run's namespace suffix (see
// searchCorpusFor below) rather than kept fully static: /v1/remember
// dedupes by content across the caller's whole account, not scoped to
// namespace, so a byte-identical corpus across two conformance runs
// returns the *first* run's id sitting in the *first* run's
// (now-forgotten) namespace — invisible to this run's `/v1/recent` poll.
// The suffix keeps content unique per run while leaving the topic
// keywords assertions key off (`espresso`, `Longhorn`, `vector`, ...)
// untouched.
var searchCorpusBase = []string{
	"The kw cluster ingress uses Cilium with kube-vip to provide the shared VIP for ingress-nginx",
	"Longhorn provides replicated block storage for stateful workloads on the kw cluster",
	"Pascal prefers espresso over filter coffee in the morning and drinks it before starting work",
	"The espresso machine in Pascal's kitchen is a Lelit Bianca with PID temperature control and flow profiling",
	"novamem stores memories in a warm Postgres tier for recent data and a cold vector tier for older data",
	"The novamem cold vector tier supports both pgvector and Qdrant as backend implementations",
	"The tax filing deadline for the 2026 fiscal year in Belgium is at the end of April",
	"The cat's vet appointment for its annual checkup is scheduled on Fridays",
}

func searchCorpusFor(nsName string) []string {
	out := make([]string, len(searchCorpusBase))
	for i, fact := range searchCorpusBase {
		out[i] = fmt.Sprintf("%s (conformance run %s)", fact, nsName)
	}
	return out
}

// seedSearchCorpus seeds the corpus into nsName and polls /v1/recent
// until every seeded id is visible, since async enrichment means the 201
// can precede indexing. Fails on any worthiness-gate rejection
// (`id: null`) — a silently-thin corpus would make every downstream
// membership/ranking assertion meaningless, so this must fail loudly
// rather than skip.
func seedSearchCorpus(t *testing.T, nsName string) []string {
	t.Helper()
	var ids []string
	for _, content := range searchCorpusFor(nsName) {
		r := API(t, "/v1/remember", Opts{
			Body: map[string]any{"content": content, "namespace": nsName},
		})
		if r.Status != 201 {
			t.Fatalf("seed failed: HTTP %d for %q", r.Status, content)
		}
		parsed := r.MustValidate(t, RememberResponse)
		id, _ := parsed["id"].(string)
		if id == "" {
			t.Fatalf("seed rejected by worthiness gate (rejected=%q) for: %q", parsed["rejected"], content)
		}
		ids = append(ids, id)
	}

	deadline := time.Now().Add(45 * time.Second)
	visible := map[string]bool{}
	for time.Now().Before(deadline) {
		// k is intentionally much larger than the corpus size: the oracle
		// runs an async observer/extraction pass that derives additional
		// `[fact] ...]` entries per seeded item (visible in manual
		// probing), which crowd a tight `k` window in /v1/recent's recency
		// ordering and can push original seeded ids out of a same-size k
		// before extraction settles.
		r := API(t, "/v1/recent", Opts{
			Body: map[string]any{"namespace": nsName, "k": 200},
		})
		if r.Status == 200 {
			parsed := r.MustValidate(t, RecentResponse)
			visible = map[string]bool{}
			for _, e := range parsed["results"].([]any) {
				id, _ := e.(map[string]any)["id"].(string)
				visible[id] = true
			}
			all := true
			for _, id := range ids {
				if !visible[id] {
					all = false
					break
				}
			}
			if all {
				return ids
			}
		}
		time.Sleep(1 * time.Second)
	}
	var missing []string
	for _, id := range ids {
		if !visible[id] {
			missing = append(missing, id)
		}
	}
	t.Fatalf("seed indexing did not converge within 45s; missing ids: %s", strings.Join(missing, ", "))
	return nil
}

// searchResults validates a /v1/search-shaped body and returns its
// entries (each already checked against MemoryEntry via RecentResponse).
func searchResults(t *testing.T, r Result) []map[string]any {
	t.Helper()
	parsed := r.MustValidate(t, RecentResponse)
	var entries []map[string]any
	for _, e := range parsed["results"].([]any) {
		if err := Validate(e, MemoryEntry); err != nil {
			t.Fatalf("entry shape: %v", err)
		}
		entries = append(entries, e.(map[string]any))
	}
	return entries
}

func TestHybridSearch(t *testing.T) {
	Target(t)
	nsName := NS()

	// beforeAll: seed the corpus and wait for indexing to converge.
	seededIds := seedSearchCorpus(t, nsName)

	// afterAll: best-effort forget of every seeded id (errors ignored).
	t.Cleanup(func() {
		for _, id := range seededIds {
			_, _ = apiE("/v1/forget", Opts{Body: map[string]any{"id": id}})
		}
	})

	t.Run("POST /v1/search finds topical matches in top-k", func(t *testing.T) {
		r := API(t, "/v1/search", Opts{
			Body: map[string]any{"query": "coffee machine", "namespace": nsName, "k": 4},
		})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		entries := searchResults(t, r)
		found := false
		for _, e := range entries {
			if strings.Contains(e["content"].(string), "espresso") {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("no top-k entry mentions %q", "espresso")
		}
	})

	t.Run("POST /v1/search scores are monotonically non-increasing", func(t *testing.T) {
		r := API(t, "/v1/search", Opts{
			Body: map[string]any{"query": "vector storage backend", "namespace": nsName, "k": 8},
		})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		entries := searchResults(t, r)
		scores := make([]float64, len(entries))
		for i, e := range entries {
			if s, ok := e["score"].(float64); ok { // e.score ?? 0
				scores[i] = s
			}
		}
		for i := 1; i < len(scores); i++ {
			if scores[i] > scores[i-1] {
				t.Fatalf("scores not monotonically non-increasing: %v", scores)
			}
		}
	})

	t.Run("POST /v1/search scopes results to the requested namespace", func(t *testing.T) {
		r := API(t, "/v1/search", Opts{
			Body: map[string]any{"query": "cluster storage", "namespace": nsName, "k": 8},
		})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		entries := searchResults(t, r)
		if len(entries) == 0 {
			t.Fatal("expected at least one result")
		}
		for _, e := range entries {
			if ns, present := e["namespace"]; present {
				if ns != nsName {
					t.Fatalf("namespace = %v, want %q", ns, nsName)
				}
			}
		}
	})

	t.Run("POST /v1/neighbors returns graph-adjacent entries for a seeded id", func(t *testing.T) {
		seedId := seededIds[0]
		r := API(t, "/v1/neighbors", Opts{Body: map[string]any{"id": seedId}})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		parsed := r.MustValidate(t, RecentResponse)
		if _, ok := parsed["results"].([]any); !ok {
			t.Fatalf("results is %T, want array", parsed["results"])
		}
	})

	t.Run("POST /v1/context responds 200 with a relevant + recent context pack", func(t *testing.T) {
		r := API(t, "/v1/context", Opts{
			Body: map[string]any{"message": "tell me about cluster storage", "namespace": nsName},
		})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		body := r.MustValidate(t, Schema{
			"relevant": Schema{"results": Arr(MemoryEntry)},
		})
		found := false
		for _, e := range body["relevant"].(map[string]any)["results"].([]any) {
			content := e.(map[string]any)["content"].(string)
			if strings.Contains(content, "Longhorn") || strings.Contains(content, "vector") {
				found = true
				break
			}
		}
		if !found {
			t.Fatal("no relevant entry mentions Longhorn or vector")
		}
		if _, ok := body["guidance"].(string); !ok {
			t.Fatalf("guidance is %T, want string", body["guidance"])
		}
	})

	t.Run("GET /v1/context-prefix responds 200 with a prefix or 404 when the observer is disabled", func(t *testing.T) {
		r := API(t, "/v1/context-prefix", Opts{})
		if r.Status != 200 && r.Status != 404 {
			t.Fatalf("status = %d, want 200 or 404", r.Status)
		}
		if r.Status == 200 {
			if _, ok := r.Field(t, "prefix").(string); !ok {
				t.Fatalf("prefix is %T, want string", r.Field(t, "prefix"))
			}
		} else {
			if _, ok := r.Field(t, "error").(string); !ok {
				t.Fatalf("error is %T, want string", r.Field(t, "error"))
			}
		}
	})
}
