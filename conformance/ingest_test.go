package conformance

// Port of suites/30-ingest.test.ts.
//
// Read-only transcription source: `packages/server/src/routes/data-plane.ts`
// + `routes/schemas.ts` + the corresponding `engine/index.ts` methods
// (`capture`, `hygieneReport`, `evaluateMemoryQuality`, `decay`,
// `dreamCycle`, `reapOrphans`, `runObserver`), read-only, never imported.
//
// Admin gating, verified against source rather than assumed from the task
// brief: `requireOperator` (context.ts) delegates to `requireAdmin` in
// `user` auth mode, which checks `req.dashUser` — a Better-Auth *session*,
// never a bearer token. `http.ts`'s `wantsDashUser` allowlist that resolves
// an `nm_…` bearer into a `dashUser` only covers `/v1/auth/*`, `/v1/me/*`,
// `/v1/admin/*` — NOT the maintenance routes. So a data-plane bearer can
// never satisfy `requireOperator` here, admin token or not; only the
// session cookie (AdminCookieAPI) can. This applies to all four operator
// routes, including `/v1/observe` — the task brief's brief only names
// decay/dream-cycle/reap-orphans as "admin-gated", but the source shows
// `/v1/observe` behind the identical `requireOperator` call.
//
// decay/dream-cycle/reap-orphans/observe run REAL maintenance against the
// shared bench oracle's live DB. They are idempotent and cheap on this
// small dataset, but each is invoked at most ONCE in this file (a single
// subtest each) — no loops, no retries.

import (
	"net/http"
	"testing"
)

func TestIngestPipeline(t *testing.T) {
	Target(t)
	suiteNS := NS()
	var createdIDs []string
	// afterAll: forget everything this file minted; failures ignored
	// (TS `.catch(() => {})`).
	t.Cleanup(func() {
		for _, id := range createdIDs {
			_, _ = apiE("/v1/forget", Opts{Body: map[string]string{"id": id}})
		}
	})

	t.Run("POST /v1/capture stores a substantive fact", func(t *testing.T) {
		r := API(t, "/v1/capture", Opts{Body: map[string]string{
			"content":   "The conformance suite's ingest test namespace is " + suiteNS + ", created for verifying the capture endpoint",
			"namespace": suiteNS,
		}})
		if r.Status != 201 {
			t.Fatalf("status = %d, want 201", r.Status)
		}
		parsed := r.MustValidate(t, CaptureResponse)
		id, _ := parsed["id"].(string)
		if id == "" {
			t.Fatalf("id = %v, want truthy", parsed["id"])
		}
		createdIDs = append(createdIDs, id)
	})

	t.Run("POST /v1/capture rejects trivial filler via the worthiness gate", func(t *testing.T) {
		// "ok thanks" is 9 chars — under shouldReject()'s 12-char floor, so it
		// is rejected as "too short — not durable knowledge" before ever
		// reaching the embedder. No id is minted, so there is nothing to
		// dedupe or forget; the observable contract is id:null + rejected set.
		r := API(t, "/v1/capture", Opts{Body: map[string]string{
			"content":   "ok thanks",
			"namespace": suiteNS,
		}})
		if r.Status != 201 {
			t.Fatalf("status = %d, want 201", r.Status)
		}
		parsed := r.MustValidate(t, CaptureResponse)
		if parsed["id"] != nil {
			t.Fatalf("id = %v, want null", parsed["id"])
		}
		if rejected, _ := parsed["rejected"].(string); rejected == "" {
			t.Fatalf("rejected = %v, want truthy", parsed["rejected"])
		}
	})

	t.Run("POST /v1/session-recap ingests typed recap items as durable memories", func(t *testing.T) {
		r := API(t, "/v1/session-recap", Opts{Body: map[string]any{
			"namespace": suiteNS,
			"other": []string{
				"Session recap conformance fact for namespace " + suiteNS + ": the ingest suite exercises session-recap",
			},
		}})
		if r.Status != 201 {
			t.Fatalf("status = %d, want 201", r.Status)
		}
		parsed := r.MustValidate(t, SessionRecapResponse)
		if saved, _ := parsed["saved"].(float64); saved != 1 {
			t.Fatalf("saved = %v, want 1", parsed["saved"])
		}
		results, _ := parsed["results"].([]any)
		if len(results) != 1 {
			t.Fatalf("len(results) = %d, want 1", len(results))
		}
		result, _ := results[0].(map[string]any)
		id, _ := result["id"].(string)
		if id == "" {
			t.Fatalf("results[0].id = %v, want truthy", result["id"])
		}
		createdIDs = append(createdIDs, id)
	})

	t.Run("POST /v1/evaluate runs the built-in memory-quality suite", func(t *testing.T) {
		// hygieneReport's pairwise Jaccard/contradiction scan (called inside
		// evaluateMemoryQuality) is O(n^2) over the scanned rows and the shared
		// bench's store is not tiny — same slow-under-load story as /v1/stats
		// (task-3 report), so this gets the same kind of generous headroom
		// (the shared httpClient ceiling) rather than a tight default timeout.
		r := API(t, "/v1/evaluate", Opts{Body: map[string]any{}})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		parsed := r.MustValidate(t, EvaluateResponse)
		if suite, _ := parsed["suite"].(string); suite != "core" {
			t.Fatalf("suite = %v, want %q", parsed["suite"], "core")
		}
		cases, _ := parsed["cases"].([]any)
		if len(cases) <= 0 {
			t.Fatalf("len(cases) = %d, want > 0", len(cases))
		}
		summary, _ := parsed["summary"].(map[string]any)
		if total, _ := summary["total"].(float64); total != float64(len(cases)) {
			t.Fatalf("summary.total = %v, want %d", summary["total"], len(cases))
		}
	})

	t.Run("POST /v1/hygiene returns a scan-shaped report", func(t *testing.T) {
		r := API(t, "/v1/hygiene", Opts{Body: map[string]any{"k": 5}})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		parsed := r.MustValidate(t, HygieneResponse)
		summary, _ := parsed["summary"].(map[string]any)
		if scanned, ok := summary["scanned"].(float64); !ok || scanned < 0 {
			t.Fatalf("summary.scanned = %v, want >= 0", summary["scanned"])
		}
	})

	t.Run("POST /v1/adoption returns a diagnostics report without auth beyond the data-plane token", func(t *testing.T) {
		r := API(t, "/v1/adoption", Opts{Body: map[string]any{}})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		if _, ok := r.Body.(map[string]any); !ok {
			t.Fatalf("body is %T, want object", r.Body)
		}
	})
}

func TestOperatorGatedMaintenance(t *testing.T) {
	e := Target(t)
	// Was `Boolean(env.adminCookie)` — that silently skipped every
	// operator-gated test on a run configured with EMAIL+PASSWORD instead
	// of a pre-minted cookie, which is how the bench oracle is driven.
	hasAdminCookie := e.HasAdminIdentity()

	if !hasAdminCookie {
		// Loud skip: no silent green when no admin identity is configured
		// for this oracle run.
		t.Skip("operator-gated maintenance requires NOVAMEM_ADMIN_COOKIE or NOVAMEM_ADMIN_EMAIL+PASSWORD — skipped")
	}

	t.Run("POST /v1/observe: 401 with the data-plane token, 200/503 with the admin session cookie", func(t *testing.T) {
		denied := API(t, "/v1/observe", Opts{Body: map[string]any{}})
		if denied.Status != 401 {
			t.Fatalf("denied status = %d, want 401", denied.Status)
		}
		denied.MustValidate(t, ErrorBody)

		allowed := AdminCookieAPI(t, "/v1/observe", Opts{Body: map[string]any{}})
		if allowed.Status != 200 && allowed.Status != 503 {
			t.Fatalf("allowed status = %d, want 200 or 503", allowed.Status)
		}
		if allowed.Status == 200 {
			allowed.MustValidate(t, ObserveResponse)
		} else {
			allowed.MustValidate(t, ErrorBody)
		}
	})

	// Observed a >60s stall on the shared bench (root cause not isolated —
	// possibly queued behind other requests' embedding/DB work on this
	// small single-instance oracle); the decay SQL itself is a single bulk
	// statement and normally answers in well under a second (verified
	// ad hoc via curl). Generous headroom here (the shared httpClient
	// ceiling) rather than a tight bound, matching the /v1/stats precedent
	// in 10-data-plane.test.ts.
	t.Run("POST /v1/decay: 401 with the data-plane token, 200 with the admin session cookie", func(t *testing.T) {
		denied := API(t, "/v1/decay", Opts{Body: map[string]any{}})
		if denied.Status != 401 {
			t.Fatalf("denied status = %d, want 401", denied.Status)
		}
		denied.MustValidate(t, ErrorBody)

		allowed := AdminCookieAPI(t, "/v1/decay", Opts{Body: map[string]any{}})
		if allowed.Status != 200 {
			t.Fatalf("allowed status = %d, want 200", allowed.Status)
		}
		allowed.MustValidate(t, DecayResponse)
	})

	// Observed on the shared bench oracle: a single real run took
	// durationMs 346816 (~5m47s) — dream-cycle walks up to 5000 warm
	// entries plus up to 1000 facts through real embeddings and an LLM
	// judge per candidate cluster (factClustersJudged: 118 in that run), so
	// multi-minute latency is the actual contract here, not a fluke. The
	// shared httpClient's 11-minute ceiling gives it real headroom above
	// the observed run rather than treating slowness as a bug; the
	// assertion itself stays exact.
	t.Run("POST /v1/dream-cycle: 401 with the data-plane token, 200 with the admin session cookie", func(t *testing.T) {
		// No body schema on this route, and API() defaults to GET when no
		// body is given — this route only registers POST, so an implicit
		// GET would 404 rather than exercise the auth gate. Force POST.
		denied := API(t, "/v1/dream-cycle", Opts{Method: http.MethodPost})
		if denied.Status != 401 {
			t.Fatalf("denied status = %d, want 401", denied.Status)
		}
		denied.MustValidate(t, ErrorBody)

		allowed := AdminCookieAPI(t, "/v1/dream-cycle", Opts{Method: http.MethodPost})
		if allowed.Status != 200 {
			t.Fatalf("allowed status = %d, want 200", allowed.Status)
		}
		allowed.MustValidate(t, DreamCycleResponse)
	})

	t.Run("POST /v1/reap-orphans: 401 with the data-plane token, 200 with the admin session cookie", func(t *testing.T) {
		// Same GET-default trap as dream-cycle above — force POST.
		denied := API(t, "/v1/reap-orphans", Opts{Method: http.MethodPost})
		if denied.Status != 401 {
			t.Fatalf("denied status = %d, want 401", denied.Status)
		}
		denied.MustValidate(t, ErrorBody)

		allowed := AdminCookieAPI(t, "/v1/reap-orphans", Opts{Method: http.MethodPost})
		if allowed.Status != 200 {
			t.Fatalf("allowed status = %d, want 200", allowed.Status)
		}
		allowed.MustValidate(t, ReapOrphansResponse)
	})
}
