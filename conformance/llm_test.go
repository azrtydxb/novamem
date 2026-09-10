package conformance

// Port of suites/90-llm.test.ts.
//
// The three LLM subsystems the parity audit parked as "accepted
// divergence #14" and later closed: fact extraction
// (NOVAMEM_EXTRACTION_*), the observer (NOVAMEM_OBSERVER_*, which backs
// `/v1/observe` and `/v1/context-prefix`), and query decomposition
// (NOVAMEM_QUERY_DECOMP_*, `decompose: true` on `/v1/search`).
//
// Transcription sources (read-only): `engine/index.ts`
// (`storeFactsForChunk` — derived facts land in the SAME namespace as
// their chunk, carrying `metadata.fact` and
// `metadata.source_chunk_id` → the chunk's id), `engine/observer.ts`,
// `engine/query-decomposer.ts`, `routes/data-plane.ts`.
//
// GATING. `NOVAMEM_LLM_SUBSYSTEMS=1` asserts the subsystems are ON and
// fails when they don't behave. Without it these tests skip LOUDLY —
// they never silently pass, because a silent pass is exactly how a
// missing subsystem stayed invisible through a green conformance run.
//
// These are REAL LLM round-trips against the target's configured
// endpoint, so the timeouts are generous and the retries bounded.

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"
)

// skipUnlessLLM is the loud gate: without NOVAMEM_LLM_SUBSYSTEMS the
// suite skips with a visible reason, never silently passes.
func skipUnlessLLM(t *testing.T, e Env) {
	t.Helper()
	if !e.LLMSubsystems {
		t.Skip("SKIPPED — NOVAMEM_LLM_SUBSYSTEMS is not set; extraction/observer/decomposition are unverified")
	}
}

func TestLLMObserver(t *testing.T) {
	e := Target(t)
	skipUnlessLLM(t, e)

	t.Run("GET /v1/context-prefix returns a well-formed prefix", func(t *testing.T) {
		r := API(t, "/v1/context-prefix", Opts{})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200 — observer is disabled on this target but NOVAMEM_LLM_SUBSYSTEMS=1 was declared", r.Status)
		}
		if _, ok := r.Obj(t)["prefix"].(string); !ok {
			t.Fatalf("prefix is %T, want string", r.Obj(t)["prefix"])
		}
	})

	t.Run("POST /v1/observe runs the observer pass for an operator", func(t *testing.T) {
		if !e.HasAdminIdentity() {
			t.Skip("SKIPPED — POST /v1/observe needs an admin session cookie (operator-gated)")
		}
		denied := API(t, "/v1/observe", Opts{Body: map[string]any{}})
		if denied.Status != 401 {
			t.Fatalf("status = %d, want 401", denied.Status)
		}

		r := AdminCookieAPI(t, "/v1/observe", Opts{Body: map[string]any{}})
		// 503 is the "observer configured but its endpoint is unreachable"
		// answer; with the subsystem declared on we require the real one.
		if r.Status != 200 {
			raw, _ := json.Marshal(r.Body)
			t.Fatalf("observe → %s: status = %d, want 200", raw, r.Status)
		}
		r.MustValidate(t, ObserveResponse)
	})
}

func TestLLMQueryDecomposition(t *testing.T) {
	e := Target(t)
	skipUnlessLLM(t, e)

	t.Run("POST /v1/search with decompose:true returns a well-formed result set", func(t *testing.T) {
		// Deliberately multi-hop so the decomposer has something to split.
		// The contract asserted here is SHAPE, not ranking: decomposition is
		// a retrieval-quality feature, and pinning which entries come back
		// would make this a model-version test rather than a contract test.
		body := map[string]any{
			"query":     "which storage layer does the cluster use and who prefers espresso",
			"k":         5,
			"decompose": true,
		}
		r := API(t, "/v1/search", Opts{Body: body})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		parsed := r.MustValidate(t, RecentResponse)
		results := parsed["results"].([]any)
		var scores []float64
		for _, ea := range results {
			if err := Validate(ea, MemoryEntry); err != nil {
				t.Fatalf("result shape: %v", err)
			}
			score, _ := ea.(map[string]any)["score"].(float64)
			scores = append(scores, score)
		}
		if !sort.SliceIsSorted(scores, func(i, j int) bool { return scores[i] > scores[j] }) {
			t.Fatalf("scores not sorted descending: %v", scores)
		}

		// decompose:true must not change the response ENVELOPE — clients
		// parse both the same way.
		plainBody := map[string]any{}
		for k, v := range body {
			plainBody[k] = v
		}
		plainBody["decompose"] = false
		plain := API(t, "/v1/search", Opts{Body: plainBody})
		if plain.Status != 200 {
			t.Fatalf("status = %d, want 200", plain.Status)
		}
		plain.MustValidate(t, RecentResponse)
		if dk, pk := sortedKeys(r.Obj(t)), sortedKeys(plain.Obj(t)); dk != pk {
			t.Fatalf("envelope keys differ: decompose=%s plain=%s", dk, pk)
		}
	})
}

func sortedKeys(m map[string]any) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}

func TestLLMFactExtraction(t *testing.T) {
	e := Target(t)
	skipUnlessLLM(t, e)

	t.Run("a written chunk yields derived facts pointing back at it", func(t *testing.T) {
		namespace := NS()
		createdIDs := map[string]bool{}
		t.Cleanup(func() {
			for id := range createdIDs {
				_, _ = apiE("/v1/forget", Opts{Body: map[string]any{"id": id}})
			}
		})

		// The subject has to be unique per run, not just a trailing marker.
		// Exact-duplicate suppression is scoped to (user, project,
		// content_hash) and deliberately ignores namespace, so a derived
		// fact identical to one an earlier run already stored is silently
		// not re-inserted — and this test would then find nothing in its own
		// namespace and blame extraction. With a generic subject that
		// happened whenever the model didn't echo the marker into the fact
		// text: green on the first run, red on later ones, for a server
		// doing exactly the right thing. An invented subject can't collide.
		subject := fmt.Sprintf("Quorlax-%s", namespace)
		chunk := API(t, "/v1/remember", Opts{Body: map[string]any{
			"namespace": namespace,
			"content": subject + " runs the kw Kubernetes cluster from Dubai, uses Longhorn for replicated " +
				"block storage, and pulls espresso on a Lelit Bianca every morning.",
		}})
		if chunk.Status != 201 {
			t.Fatalf("status = %d, want 201", chunk.Status)
		}
		chunkID, _ := chunk.MustValidate(t, RememberResponse)["id"].(string)
		if chunkID == "" {
			t.Fatal("worthiness gate rejected the extraction probe chunk")
		}
		createdIDs[chunkID] = true

		// Extraction is fire-and-forget off the write path: one LLM call plus
		// one batched embed, then N inserts. Bounded poll — 120s at 3s is far
		// above the observed few seconds, and fails loudly rather than hanging.
		var derived []map[string]any
		deadline := time.Now().Add(120 * time.Second)
		for time.Now().Before(deadline) {
			recent := API(t, "/v1/recent", Opts{Body: map[string]any{
				"namespace": namespace,
				"k":         200,
			}})
			if recent.Status == 200 {
				parsed := recent.MustValidate(t, RecentResponse)
				derived = nil
				for _, ea := range parsed["results"].([]any) {
					if err := Validate(ea, MemoryEntry); err != nil {
						t.Fatalf("recent result shape: %v", err)
					}
					entry := ea.(map[string]any)
					// Everything in this run's private namespace is ours to clean up,
					// including the derived facts we never asked for by id.
					createdIDs[entry["id"].(string)] = true
					meta, _ := entry["metadata"].(map[string]any)
					if src, _ := meta["source_chunk_id"].(string); src == chunkID {
						derived = append(derived, entry)
					}
				}
				if len(derived) > 0 {
					break
				}
			}
			time.Sleep(3 * time.Second)
		}

		if len(derived) == 0 {
			t.Fatal("no derived facts appeared within 120s — extraction is off on this target")
		}

		for _, f := range derived {
			// Derived facts stay in their chunk's namespace and carry the
			// structured fact object the answerer joins on.
			meta, _ := f["metadata"].(map[string]any)
			fact, ok := meta["fact"].(map[string]any)
			if !ok {
				t.Fatalf("derived entry %v has no metadata.fact", f["id"])
			}
			if _, ok := fact["subject"].(string); !ok {
				t.Fatalf("fact.subject is %T, want string", fact["subject"])
			}
			if _, ok := fact["predicate"].(string); !ok {
				t.Fatalf("fact.predicate is %T, want string", fact["predicate"])
			}
			// `factToText`: `[<type>] <subject> <predicate> <object>`. The type
			// is the extractor's taxonomy (fact / preference / event / …), so
			// the prefix must be derived from the metadata, not hard-coded.
			factType, ok := fact["type"].(string)
			if !ok {
				t.Fatalf("fact.type is %T, want string", fact["type"])
			}
			content := f["content"].(string)
			if !strings.HasPrefix(content, "["+factType+"] ") {
				t.Fatalf("content %q does not start with %q", content, "["+factType+"] ")
			}
		}
	})
}
