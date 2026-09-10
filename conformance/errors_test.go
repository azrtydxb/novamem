package conformance

// Port of suites/80-errors.test.ts.
//
// Error-SHAPE contract: the Go server must reproduce these bodies
// byte-for-byte where integrations match on them. Transcription sources:
// `http.ts` error handler (zod envelope + generic 4xx/500 shapes),
// `routes/context.ts` (confined-token message — load-bearing, the Go
// client's conformance and NovaFlow match on it). Read-only.

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestErrorShapes(t *testing.T) {
	Target(t)

	// Every token this suite mints gets revoked. The read-only probe below
	// used to leak one per run: 18 live `conf-err-ro-*` tokens had piled up
	// on novamem-bench, each one a working credential and every one of them
	// cluttering the dashboard's per-token usage table.
	var mintedTokens []string
	t.Cleanup(func() {
		var failed []string
		for _, token := range mintedTokens {
			r := AdminAPI(t, "/v1/admin/tokens/revoke", Opts{
				Body: map[string]any{"token": token},
			})
			// Fail loudly rather than leak quietly. A cleanup that swallows
			// its own errors is how the 18 tokens got there in the first
			// place: the run stays green while working credentials pile up
			// on the target.
			revoked := false
			if m, ok := r.Body.(map[string]any); ok {
				revoked, _ = m["revoked"].(bool)
			}
			if r.Status != 200 || !revoked {
				raw, _ := json.Marshal(r.Body)
				failed = append(failed, fmt.Sprintf("%s… → %d %s", token[:min(12, len(token))], r.Status, raw))
			}
		}
		if len(failed) > 0 {
			t.Errorf("conformance leaked %d live token(s) — revoke failed:\n  %s",
				len(failed), strings.Join(failed, "\n  "))
		}
	})

	t.Run("400: zod envelope with issues[] for a missing required field", func(t *testing.T) {
		r := API(t, "/v1/remember", Opts{Body: map[string]any{}})
		if r.Status != 400 {
			t.Fatalf("status = %d, want 400", r.Status)
		}
		if got := r.Field(t, "error"); got != "invalid request body" {
			t.Fatalf("error = %v, want %q", got, "invalid request body")
		}
		issues, ok := r.Field(t, "issues").([]any)
		if !ok {
			t.Fatalf("issues is %T, want array", r.Field(t, "issues"))
		}
		found := false
		for _, iAny := range issues {
			if issue, ok := iAny.(map[string]any); ok && issue["path"] == "content" {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("no issue with path %q in %v", "content", issues)
		}
	})

	t.Run(`401: no token → {error: "unauthorized"}`, func(t *testing.T) {
		SkipUnless(t, "user", "bearer")
		// /v1/remember rather than /v1/search: same 401 contract on the TS
		// oracle, but remember exists from Go slice 2 while search arrives in
		// slice 3 — the probe should test auth, not route existence.
		r := API(t, "/v1/remember", Opts{
			Body:  map[string]any{"content": "x"},
			Token: NoAuth,
		})
		if r.Status != 401 {
			t.Fatalf("status = %d, want 401", r.Status)
		}
		if got := r.MustValidate(t, ErrorBody)["error"]; got != "unauthorized" {
			t.Fatalf("error = %v, want %q", got, "unauthorized")
		}
	})

	t.Run("403: read-only token write — exact message", func(t *testing.T) {
		SkipUnless(t, "user")
		mint := AdminAPI(t, "/v1/me/tokens", Opts{
			Body: map[string]any{"label": "conf-err-ro-" + NS(), "scope": "read_only"},
		})
		if mint.Status != 201 {
			t.Fatalf("mint status = %d, want 201", mint.Status)
		}
		token, _ := mint.Field(t, "token").(string)
		mintedTokens = append(mintedTokens, token)
		r := API(t, "/v1/remember", Opts{
			Body:  map[string]any{"content": "a write that the read-only token must not perform"},
			Token: &token,
		})
		if r.Status != 403 {
			t.Fatalf("status = %d, want 403", r.Status)
		}
		// Message IS contract: clients branch on it.
		if got := r.Field(t, "error"); got != "read-only token" {
			t.Fatalf("error = %v, want %q", got, "read-only token")
		}
	})

	t.Run("404: unknown memory id on update", func(t *testing.T) {
		r := API(t, "/v1/memories/conf-nonexistent-"+NS(), Opts{
			Method: "PUT",
			Body:   map[string]any{"content": "updating a memory that does not exist anywhere"},
		})
		if r.Status != 404 {
			t.Fatalf("status = %d, want 404", r.Status)
		}
		r.MustValidate(t, ErrorBody)
	})

	t.Run("oversized content is refused with the zod envelope", func(t *testing.T) {
		// MAX_CONTENT_BYTES is 256KB (routes/schemas.ts). One byte over.
		r := API(t, "/v1/remember", Opts{
			Body: map[string]any{"content": strings.Repeat("x", 256*1024+1)},
		})
		if r.Status != 400 {
			t.Fatalf("status = %d, want 400", r.Status)
		}
		if got := r.Field(t, "error"); got != "invalid request body" {
			t.Fatalf("error = %v, want %q", got, "invalid request body")
		}
	})

	t.Run("429: write quota — loud skip unless quotas are enabled on the target", func(t *testing.T) {
		usage := AdminAPI(t, "/v1/me/usage", Opts{})
		var writesPerMinute float64
		if usage.Status == 200 {
			if quota, ok := usage.Field(t, "quota").(map[string]any); ok {
				writesPerMinute, _ = quota["writesPerMinute"].(float64)
			}
		}
		if usage.Status != 200 || writesPerMinute == 0 {
			t.Skip("write quota not enabled on the target")
		}
		// ponytail: hammer loop bounded by the quota itself; only runs on
		// quota-enabled targets, so it can't spin unbounded on the bench.
		limit := int(writesPerMinute)
		last := 0
		for i := 0; i <= limit+1; i++ {
			r := AdminAPI(t, "/v1/remember", Opts{
				Body: map[string]any{
					"content": fmt.Sprintf("quota probe fact number %d %s", i, NS()),
					"force":   true,
				},
			})
			last = r.Status
			if last == 429 {
				break
			}
		}
		if last != 429 {
			t.Fatalf("last status = %d, want 429", last)
		}
	})
}
