package conformance

// Port of suites/40-auth.test.ts.
//
// Read-only transcription source: `packages/server/src/routes/auth.ts`
// (rotate-token), `routes/me.ts` (token mint / project CRUD, ~line 135),
// `routes/context.ts` (`checkProjectAccess`, confinement 403 at ~line
// 218), and `http.ts`'s `restrictedTokenDenied` (read-only-token gate) —
// all read-only, never imported.
//
// Every token/project this suite mints is a THROWAWAY, never the shared
// `NOVAMEM_TEST_TOKEN` — rotating that would break every other suite that
// runs after this one. Cleanup is best-effort in `afterAll` (t.Cleanup on
// the owning Test function here) and never fails the suite; failures are
// logged.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"testing"
)

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

var nmPrefix = regexp.MustCompile(`^nm_`)

// cleanupForget is the afterAll forget loop: best-effort, logged, never
// failing the suite.
func cleanupForget(t *testing.T, ids []string) {
	for _, id := range ids {
		if _, err := apiE("/v1/forget", Opts{Body: map[string]any{"id": id}}); err != nil {
			t.Logf("cleanup: forget %s failed: %v", id, err)
		}
	}
}

// cleanupAdminDelete is the afterAll token/project DELETE loop via the
// admin cookie (already cached by the test body that minted the rows, so
// AdminCookie cannot fail here). Best-effort, logged, never failing.
func cleanupAdminDelete(t *testing.T, kind string, paths []string) {
	e := loadEnv()
	for _, path := range paths {
		h := map[string]string{"Cookie": AdminCookie(t)}
		if e.Origin != "" {
			h["Origin"] = e.Origin
		}
		r, err := apiE(path, Opts{Method: "DELETE", Token: NoAuth, Headers: h})
		if err != nil {
			t.Logf("cleanup: delete %s %s failed: %v", kind, path, err)
			continue
		}
		if r.Status != 200 {
			raw, _ := json.Marshal(r.Body)
			t.Logf("cleanup: delete %s %s → %d %s", kind, path, r.Status, raw)
		}
	}
}

func TestAuthGates(t *testing.T) {
	e := Target(t)

	t.Run("data plane without a token is 401 (unless mode=none)", func(t *testing.T) {
		r := API(t, "/v1/recent", Opts{Body: map[string]any{"limit": 1}, Token: NoAuth})
		want := 401
		if e.AuthMode == "none" {
			want = 200
		}
		if r.Status != want {
			t.Fatalf("status = %d, want %d", r.Status, want)
		}
	})

	t.Run("garbage bearer is 401 with error body", func(t *testing.T) {
		r := API(t, "/v1/recent", Opts{Body: map[string]any{"limit": 1}, Token: ptr("nm_bogus")})
		if e.AuthMode == "none" {
			return
		}
		if r.Status != 401 {
			t.Fatalf("status = %d, want 401", r.Status)
		}
		r.MustValidate(t, ErrorBody)
	})

	t.Run("an unauthenticated caller cannot reach /v1/admin/metrics", func(t *testing.T) {
		// Two legitimate answers, depending on the target's
		// NOVAMEM_ADMIN_DASHBOARD: 404 "admin disabled" (the surface gate
		// fires before `requireAdmin`, so it answers the same to everyone)
		// or 401 (surface on, credentials missing). Never a 2xx.
		//
		// This used to send `env.testToken` and assert the same thing — which
		// silently depended on that token NOT belonging to an admin. It does
		// on some targets and doesn't on others, and the assertion passed
		// either way only because the bench oracle had metrics switched off.
		// The genuine "authenticated non-admin is denied" case now lives in
		// 60-admin, which provisions a real non-admin bearer to make it with.
		r := API(t, "/v1/admin/metrics", Opts{Token: NoAuth})
		if r.Status != 401 && r.Status != 404 {
			t.Fatalf("status = %d, want 401 or 404", r.Status)
		}
		r.MustValidate(t, ErrorBody)
	})
}

func TestRotateTokenUserMode(t *testing.T) {
	Target(t)
	SkipUnless(t, "user")

	var mintedTokenHashes []string
	t.Cleanup(func() {
		var paths []string
		for _, hash := range mintedTokenHashes {
			paths = append(paths, "/v1/me/tokens/"+hash)
		}
		cleanupAdminDelete(t, "token", paths)
	})

	// A THROWAWAY token, minted fresh via the admin cookie, is rotated —
	// never the shared NOVAMEM_TEST_TOKEN every other suite depends on.
	t.Run("mints a throwaway, rotates it, and old dies while new works", func(t *testing.T) {
		mint := AdminCookieAPI(t, "/v1/me/tokens", Opts{
			Body: map[string]any{"label": fmt.Sprintf("conf-rotate-%s", NS())},
		})
		if mint.Status != 201 {
			t.Fatalf("mint status = %d, want 201", mint.Status)
		}
		original, _ := mint.Obj(t)["token"].(string)
		if !nmPrefix.MatchString(original) {
			t.Fatalf("token = %q, want /^nm_/", original)
		}
		mintedTokenHashes = append(mintedTokenHashes, sha256Hex(original))

		// Sanity: the freshly minted token can reach the data plane before
		// rotation.
		preCheck := API(t, "/v1/recent", Opts{Body: map[string]any{"limit": 1}, Token: ptr(original)})
		if preCheck.Status != 200 {
			t.Fatalf("pre-rotation recent status = %d, want 200", preCheck.Status)
		}

		// POST /v1/auth/rotate-token — routes/auth.ts: presents the current
		// bearer via Authorization, gets a new plaintext back, 201, old one
		// revoked atomically in the same transaction.
		rotate := API(t, "/v1/auth/rotate-token", Opts{Method: "POST", Token: ptr(original)})
		if rotate.Status != 201 {
			t.Fatalf("rotate status = %d, want 201", rotate.Status)
		}
		rotateBody := rotate.Obj(t)
		rotated, _ := rotateBody["token"].(string)
		if !nmPrefix.MatchString(rotated) {
			t.Fatalf("rotated token = %q, want /^nm_/", rotated)
		}
		if rotated == original {
			t.Fatalf("rotated token equals the original")
		}
		if w, ok := rotateBody["warning"].(string); !ok || w == "" {
			t.Fatalf("warning = %v, want truthy", rotateBody["warning"])
		}

		// Old token is dead: any data-plane call now 401s.
		oldDead := API(t, "/v1/recent", Opts{Body: map[string]any{"limit": 1}, Token: ptr(original)})
		if oldDead.Status != 401 {
			t.Fatalf("old-token recent status = %d, want 401", oldDead.Status)
		}

		// New token works.
		newWorks := API(t, "/v1/recent", Opts{Body: map[string]any{"limit": 1}, Token: ptr(rotated)})
		if newWorks.Status != 200 {
			t.Fatalf("new-token recent status = %d, want 200", newWorks.Status)
		}

		// Track the ROTATED token's hash for cleanup (the original's hash
		// is now a dead row, but deleting by its hash is a no-op 404 — track
		// the live one instead so cleanup actually removes the row).
		mintedTokenHashes[len(mintedTokenHashes)-1] = sha256Hex(rotated)
	})

	t.Run("rotate-token requires a bearer; unauthenticated is 401", func(t *testing.T) {
		r := API(t, "/v1/auth/rotate-token", Opts{Method: "POST", Token: NoAuth})
		if r.Status != 401 {
			t.Fatalf("status = %d, want 401", r.Status)
		}
	})
}

func TestProjectConfinedAndReadOnlyTokensUserMode(t *testing.T) {
	e := Target(t)
	SkipUnless(t, "user")
	if !e.HasAdminIdentity() {
		t.Skip("no admin identity — needs NOVAMEM_ADMIN_COOKIE or NOVAMEM_ADMIN_EMAIL+NOVAMEM_ADMIN_PASSWORD")
	}

	var (
		mintedTokenHashes []string
		createdProjectIds []string
		forgetIds         []string
	)
	t.Cleanup(func() {
		cleanupForget(t, forgetIds)
		var tokenPaths []string
		for _, hash := range mintedTokenHashes {
			tokenPaths = append(tokenPaths, "/v1/me/tokens/"+hash)
		}
		cleanupAdminDelete(t, "token", tokenPaths)
		var projectPaths []string
		for _, id := range createdProjectIds {
			projectPaths = append(projectPaths, "/v1/me/projects/"+id)
		}
		cleanupAdminDelete(t, "project", projectPaths)
	})

	t.Run("confined token: cross-project write is 403, own-project write succeeds", func(t *testing.T) {
		home := AdminCookieAPI(t, "/v1/me/projects", Opts{
			Body: map[string]any{"name": fmt.Sprintf("conf-home-%s", NS())},
		})
		if home.Status != 201 {
			t.Fatalf("home project status = %d, want 201", home.Status)
		}
		homeID, _ := home.Obj(t)["id"].(string)
		createdProjectIds = append(createdProjectIds, homeID)

		away := AdminCookieAPI(t, "/v1/me/projects", Opts{
			Body: map[string]any{"name": fmt.Sprintf("conf-away-%s", NS())},
		})
		if away.Status != 201 {
			t.Fatalf("away project status = %d, want 201", away.Status)
		}
		awayID, _ := away.Obj(t)["id"].(string)
		createdProjectIds = append(createdProjectIds, awayID)

		mint := AdminCookieAPI(t, "/v1/me/tokens", Opts{
			Body: map[string]any{"label": fmt.Sprintf("conf-confined-%s", NS()), "project": homeID},
		})
		if mint.Status != 201 {
			t.Fatalf("mint status = %d, want 201", mint.Status)
		}
		confined, _ := mint.Obj(t)["token"].(string)
		mintedTokenHashes = append(mintedTokenHashes, sha256Hex(confined))

		// Explicit foreign project — routes/context.ts checkProjectAccess:
		// 403 "token is confined to its project".
		crossProject := API(t, "/v1/remember", Opts{
			Token: ptr(confined),
			Body: map[string]any{
				"content": fmt.Sprintf("confined-cross-project probe %s", NS()),
				"project": awayID,
			},
		})
		if crossProject.Status != 403 {
			t.Fatalf("cross-project status = %d, want 403", crossProject.Status)
		}
		crossProject.MustValidate(t, ErrorBody)
		if got := crossProject.Obj(t)["error"]; got != "token is confined to its project" {
			t.Fatalf("error = %v, want %q", got, "token is confined to its project")
		}

		// Own (confined) project — succeeds; body.project gets rewritten to
		// the token's project regardless, but passing it explicitly here
		// exercises the same code path deterministically.
		ownProject := API(t, "/v1/remember", Opts{
			Token: ptr(confined),
			Body: map[string]any{
				"content": fmt.Sprintf("confined-own-project probe, namespace %s, home project", NS()),
				"project": homeID,
			},
		})
		if ownProject.Status != 201 {
			t.Fatalf("own-project status = %d, want 201", ownProject.Status)
		}
		if id, ok := ownProject.Obj(t)["id"].(string); ok && id != "" {
			forgetIds = append(forgetIds, id)
		}

		// No project specified at all — silently forced into the token's
		// own project (checkProjectAccess rewrites body.project), not a 403.
		noProject := API(t, "/v1/remember", Opts{
			Token: ptr(confined),
			Body: map[string]any{
				"content": fmt.Sprintf("confined-default-project probe, namespace %s, no project set", NS()),
			},
		})
		if noProject.Status != 201 {
			t.Fatalf("no-project status = %d, want 201", noProject.Status)
		}
		if id, ok := noProject.Obj(t)["id"].(string); ok && id != "" {
			forgetIds = append(forgetIds, id)
		}
	})

	t.Run("read-only token: write POST rejected, read POST allowed", func(t *testing.T) {
		mint := AdminCookieAPI(t, "/v1/me/tokens", Opts{
			Body: map[string]any{"label": fmt.Sprintf("conf-readonly-%s", NS()), "scope": "read_only"},
		})
		if mint.Status != 201 {
			t.Fatalf("mint status = %d, want 201", mint.Status)
		}
		readOnly, _ := mint.Obj(t)["token"].(string)
		mintedTokenHashes = append(mintedTokenHashes, sha256Hex(readOnly))

		// http.ts restrictedTokenDenied: scope read_only + non-GET path not
		// in the READ_POSTS allowlist → 403 "read-only token".
		write := API(t, "/v1/remember", Opts{
			Token: ptr(readOnly),
			Body:  map[string]any{"content": fmt.Sprintf("read-only-token write probe %s", NS())},
		})
		if write.Status != 403 {
			t.Fatalf("write status = %d, want 403", write.Status)
		}
		write.MustValidate(t, ErrorBody)
		if got := write.Obj(t)["error"]; got != "read-only token" {
			t.Fatalf("error = %v, want %q", got, "read-only token")
		}

		// /v1/search is in the READ_POSTS allowlist — passes despite being
		// a POST.
		read := API(t, "/v1/search", Opts{
			Token: ptr(readOnly),
			Body:  map[string]any{"query": "read-only token conformance probe", "k": 1},
		})
		if read.Status != 200 {
			t.Fatalf("read status = %d, want 200", read.Status)
		}
	})

	t.Run("restricted token cannot mutate /v1/me/tokens (self-escalation guard)", func(t *testing.T) {
		mint := AdminCookieAPI(t, "/v1/me/tokens", Opts{
			Body: map[string]any{"label": fmt.Sprintf("conf-restricted-%s", NS()), "scope": "read_only"},
		})
		if mint.Status != 201 {
			t.Fatalf("mint status = %d, want 201", mint.Status)
		}
		restricted, _ := mint.Obj(t)["token"].(string)
		mintedTokenHashes = append(mintedTokenHashes, sha256Hex(restricted))

		// http.ts restrictedTokenDenied: /v1/me/tokens mutation is denied
		// outright for a restricted bearer — minting is how it would
		// otherwise escalate itself to an unrestricted token.
		mintAttempt := API(t, "/v1/me/tokens", Opts{
			Token: ptr(restricted),
			Body:  map[string]any{"label": "should-be-denied"},
		})
		if mintAttempt.Status != 403 {
			t.Fatalf("mint-attempt status = %d, want 403", mintAttempt.Status)
		}
		if got := mintAttempt.Obj(t)["error"]; got != "restricted token" {
			t.Fatalf("error = %v, want %q", got, "restricted token")
		}
	})

	t.Run("restricted token CAN still self-rotate, preserving its restriction", func(t *testing.T) {
		// http.ts special-cases `/v1/auth/rotate-token` to bypass the
		// dashUser/restrictedTokenDenied hook entirely — the route handler
		// authenticates itself by trying to rotate the presented bearer
		// (see http.ts: "the CLI rotate-token path is reached without
		// prior auth"). rotateUserToken() then copies the old row's
		// scope/projectId onto the new row verbatim, so a restricted
		// token rotating itself does NOT escalate to a full one.
		mint := AdminCookieAPI(t, "/v1/me/tokens", Opts{
			Body: map[string]any{"label": fmt.Sprintf("conf-rotate-readonly-%s", NS()), "scope": "read_only"},
		})
		if mint.Status != 201 {
			t.Fatalf("mint status = %d, want 201", mint.Status)
		}
		original, _ := mint.Obj(t)["token"].(string)
		mintedTokenHashes = append(mintedTokenHashes, sha256Hex(original))

		rotate := API(t, "/v1/auth/rotate-token", Opts{Method: "POST", Token: ptr(original)})
		if rotate.Status != 201 {
			t.Fatalf("rotate status = %d, want 201", rotate.Status)
		}
		rotated, _ := rotate.Obj(t)["token"].(string)
		mintedTokenHashes[len(mintedTokenHashes)-1] = sha256Hex(rotated)

		// The rotated token is still read-only: a write is still 403.
		write := API(t, "/v1/remember", Opts{
			Token: ptr(rotated),
			Body:  map[string]any{"content": fmt.Sprintf("rotated-readonly write probe %s", NS())},
		})
		if write.Status != 403 {
			t.Fatalf("write status = %d, want 403", write.Status)
		}
		if got := write.Obj(t)["error"]; got != "read-only token" {
			t.Fatalf("error = %v, want %q", got, "read-only token")
		}
	})
}
