package conformance

// Port of suites/50-me.test.ts.
//
// Read-only transcription source: `packages/server/src/routes/me.ts`
// (every /v1/me/* handler), `routes/context.ts` (`requireDashUser`,
// `resolveProjectRef`, `checkProjectAccess`), `routes/schemas.ts`
// (Mint/CreateProject/ActiveProject/AddMember/MeChanges/MeExport/MeImport
// bodies), `warm-store/index.ts` (`createProject`, `exportEntries`,
// `listChanges`, `getUserQuota`, `listProjectMembers`, `listRecentActivity`),
// and `engine/index.ts` (`remember`, `deleteProject`, `logChange`) — all
// read-only, never imported.
//
// NOTE ON SOURCE: the TS suite's worktree `packages/server/src/routes/
// me.ts` predates the changelog/export/import/usage endpoints (they land
// on `feat/export-import`, `feat/change-log`, `feat/user-quotas`, not yet
// merged to that branch's base). The live oracle already serves all of
// them (confirmed via `GET /openapi.json`, matching `coverage.ts`'s
// `50-me` manifest), so this suite's oracle knowledge for those four
// routes was transcribed from `git show feat/export-import:packages/
// server/src/routes/me.ts` (and the corresponding `warm-store`/`engine`
// files on that branch) — still read-only, never imported, just a
// different ref of the same file this task already owns.
//
// Credentials: `/v1/me/*` accepts EITHER a Better-Auth session cookie
// (`AdminCookieAPI`) OR a full-scope `nm_…` bearer (`e.TestToken`, via
// plain `API()`) — `http.ts`'s `wantsDashUser` allowlist resolves an
// `nm_` bearer into `req.dashUser` for `/v1/me/*` same as it does for
// `/v1/auth/*` and `/v1/admin/*`. Verified directly against the live
// oracle (`curl` with each credential against `/v1/me/today` etc., both
// 200) before writing this suite. Both credential paths are exercised
// below rather than assumed.
//
// Active-project semantics (source-verified, corrects a naive "it's just
// a UI pointer" assumption): `checkProjectAccess` (context.ts) DOES
// consult the active-project pointer for unconfined bearers. For
// `/v1/remember` (`unionWithActive: false`), when the request body has
// no `project`/`includeProjects` at all, an active project is
// substituted directly as `body.project` — so a plain `remember()` call
// silently lands in the active project once one is set. This suite
// exercises exactly that: sets active-project, then remembers with NO
// explicit `project`, and confirms the entry landed there.
//
// Every project/token/memory this suite creates is a THROWAWAY under a
// unique namespace; cleanup is best-effort (log-and-continue, never
// fails the suite). Deleting the project at the end removes its memory
// entries too (`engine.deleteProject`), so entries written INTO the
// project don't need individual `/v1/forget` cleanup — only entries
// written outside any project are tracked separately.

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

// sha256Hex is shared with auth_test.go.

// meSkipGuard mirrors describe.skipIf(env.authMode !== "user" ||
// !hasAdminIdentity) on "/v1/me lifecycle (user mode)".
func meSkipGuard(t *testing.T) Env {
	t.Helper()
	e := Target(t)
	SkipUnless(t, "user")
	if !e.HasAdminIdentity() {
		t.Skip("no admin identity (NOVAMEM_ADMIN_COOKIE or NOVAMEM_ADMIN_EMAIL+NOVAMEM_ADMIN_PASSWORD)")
	}
	return e
}

// meCookieE is a best-effort cookie-authed request for cleanup paths:
// unlike AdminCookieAPI it never fails the test (afterAll in TS is
// log-and-continue).
func meCookieE(e Env, cookie, path, method string) (Result, error) {
	h := map[string]string{"Cookie": cookie}
	if e.Origin != "" {
		h["Origin"] = e.Origin
	}
	return apiE(path, Opts{Method: method, Token: NoAuth, Headers: h})
}

func TestMeUnauthenticatedTodayIs401(t *testing.T) {
	meSkipGuard(t)
	// "unauthenticated GET /v1/me/today is 401"
	r := API(t, "/v1/me/today", Opts{Token: NoAuth})
	if r.Status != 401 {
		t.Fatalf("status = %d, want 401", r.Status)
	}
	body := r.MustValidate(t, ErrorBody)
	if body["error"] != "unauthorized" {
		t.Fatalf("error = %v, want %q", body["error"], "unauthorized")
	}
}

// TestMeFullLifecycle is "full lifecycle: project → active-project →
// remember → today/changes/metrics/onboarding/usage/export → members →
// tokens → clear/delete".
func TestMeFullLifecycle(t *testing.T) {
	e := meSkipGuard(t)
	ns := NS()

	var createdProjectIds []string
	var mintedTokenHashes []string
	var forgetIds []string
	cookie := AdminCookie(t)
	t.Cleanup(func() {
		for _, id := range forgetIds {
			if _, err := apiE("/v1/forget", Opts{Body: map[string]any{"id": id}}); err != nil {
				t.Logf("cleanup: forget %s failed: %v", id, err)
			}
		}
		for _, hash := range mintedTokenHashes {
			r, err := meCookieE(e, cookie, "/v1/me/tokens/"+hash, "DELETE")
			if err != nil {
				t.Logf("cleanup: delete token %s failed: %v", hash, err)
			} else if r.Status != 200 && r.Status != 404 {
				t.Logf("cleanup: delete token %s → %d %v", hash, r.Status, r.Body)
			}
		}
		for _, id := range createdProjectIds {
			// Always clear active-project before deleting, in case a test
			// failed mid-lifecycle and left it pointed at a project we're
			// about to remove.
			if _, err := meCookieE(e, cookie, "/v1/me/active-project", "DELETE"); err != nil {
				t.Logf("cleanup: clear active-project failed: %v", err)
			}
			r, err := meCookieE(e, cookie, "/v1/me/projects/"+id, "DELETE")
			if err != nil {
				t.Logf("cleanup: delete project %s failed: %v", id, err)
			} else if r.Status != 200 && r.Status != 404 {
				t.Logf("cleanup: delete project %s → %d %v", id, r.Status, r.Body)
			}
		}
	})

	// ── 0. One user-global entry, BEFORE an active project exists ──
	// /v1/me/onboarding derives `remembered` from recent(user, {k:1})
	// with no project scope — on both servers — and once an active
	// project is set, unscoped writes land in that project. Long-lived
	// oracle accounts already had user-global rows, which masked this;
	// a fresh account does not. Write one while writes are still
	// user-global so step 8 tests the endpoint, not account history.
	globalWrite := API(t, "/v1/remember", Opts{
		Body: map[string]any{"content": "onboarding probe entry " + NS() + " written user-global"},
	})
	if globalWrite.Status != 200 && globalWrite.Status != 201 {
		t.Fatalf("global remember status = %d, want 200 or 201", globalWrite.Status)
	}

	// ── 1. Create a project (AdminCookieAPI = session cookie) ──────
	create := AdminCookieAPI(t, "/v1/me/projects", Opts{
		Body: map[string]any{"name": "conf-me-" + ns},
	})
	if create.Status != 201 {
		t.Fatalf("create project status = %d, want 201", create.Status)
	}
	createBody := create.MustValidate(t, ProjectResponse)
	projectID := createBody["id"].(string)
	ownerUserID := createBody["ownerUserId"].(string)
	createdProjectIds = append(createdProjectIds, projectID)

	// ── 2. Set active-project ───────────────────────────────────────
	setActive := AdminCookieAPI(t, "/v1/me/active-project", Opts{
		Method: "PUT",
		Body:   map[string]any{"project": projectID},
	})
	if setActive.Status != 200 {
		t.Fatalf("set active-project status = %d, want 200", setActive.Status)
	}
	if active, _ := setActive.Field(t, "active").(map[string]any); active == nil || active["id"] != projectID {
		t.Fatalf("set active-project active = %v, want id %q", setActive.Field(t, "active"), projectID)
	}

	// ── 3. GET active-project confirms it, with the full-scope bearer
	//      too (not just the cookie that set it — same user account) ──
	getActiveCookie := AdminCookieAPI(t, "/v1/me/active-project", Opts{})
	if getActiveCookie.Status != 200 {
		t.Fatalf("get active-project (cookie) status = %d, want 200", getActiveCookie.Status)
	}
	getActiveCookie.MustValidate(t, ActiveProjectResponse)
	if active, _ := getActiveCookie.Field(t, "active").(map[string]any); active == nil || active["id"] != projectID {
		t.Fatalf("get active-project (cookie) active = %v, want id %q", getActiveCookie.Field(t, "active"), projectID)
	}

	getActiveBearer := API(t, "/v1/me/active-project", Opts{})
	if getActiveBearer.Status != 200 {
		t.Fatalf("get active-project (bearer) status = %d, want 200", getActiveBearer.Status)
	}
	if active, _ := getActiveBearer.Field(t, "active").(map[string]any); active == nil || active["id"] != projectID {
		t.Fatalf("get active-project (bearer) active = %v, want id %q", getActiveBearer.Field(t, "active"), projectID)
	}

	// ── 4. Remember WITHOUT an explicit project — checkProjectAccess
	//      (unionWithActive: false for writes) substitutes the active
	//      project directly into body.project. ─────────────────────
	content := "conf-me lifecycle probe " + ns + ": the espresso machine needs descaling monthly"
	// Captured just before the write so the /v1/me/changes query below
	// can scope to `since` — the changelog defaults to oldest-first
	// (page 1 of up to 200 rows), so on an oracle with plenty of prior
	// changelog history a bare query would never reach our new row.
	sinceTs := time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
	remember := API(t, "/v1/remember", Opts{
		Body: map[string]any{"content": content, "namespace": ns},
	})
	if remember.Status != 201 {
		t.Fatalf("remember status = %d, want 201", remember.Status)
	}
	entryID, _ := remember.Field(t, "id").(string)
	if entryID == "" {
		t.Fatalf("remember id = %v, want non-null", remember.Field(t, "id"))
	}

	// Confirm it actually landed in the active project (not the
	// user-global scope) by reading it back scoped to that project.
	recentInProject := API(t, "/v1/recent", Opts{
		Body: map[string]any{"project": projectID, "k": 10},
	})
	if recentInProject.Status != 200 {
		t.Fatalf("recent (project) status = %d, want 200", recentInProject.Status)
	}
	foundInProject := false
	if results, ok := recentInProject.Field(t, "results").([]any); ok {
		for _, item := range results {
			if m, ok := item.(map[string]any); ok && m["id"] == entryID {
				foundInProject = true
			}
		}
	}
	if !foundInProject {
		t.Fatalf("entry %s not found in active project's recent results", entryID)
	}

	// ── 5. /v1/me/today shows the remember as recent activity ──────
	today := API(t, "/v1/me/today", Opts{})
	if today.Status != 200 {
		t.Fatalf("today status = %d, want 200", today.Status)
	}
	todayBody := today.MustValidate(t, TodayResponse)
	sawToday := false
	for _, ev := range todayBody["events"].([]any) {
		m := ev.(map[string]any)
		if m["kind"] == "remember" && strings.Contains(m["text"].(string), "conf-me lifecycle probe "+ns) {
			sawToday = true
		}
	}
	if !sawToday {
		t.Fatal("expected a 'remember' /v1/me/today event mentioning the lifecycle probe")
	}

	// ── 6. /v1/me/changes shows the "created" change — recordChanges
	//      is fire-and-forget, so poll briefly rather than assume
	//      synchronous visibility. ─────────────────────────────────
	sawCreated := false
	for attempt := 0; attempt < 10 && !sawCreated; attempt++ {
		changes := API(t, "/v1/me/changes?since="+url.QueryEscape(sinceTs), Opts{Method: "GET"})
		if changes.Status != 200 {
			t.Fatalf("changes status = %d, want 200", changes.Status)
		}
		changesBody := changes.MustValidate(t, ChangesResponse)
		for _, ch := range changesBody["changes"].([]any) {
			m := ch.(map[string]any)
			if m["entryId"] == entryID && m["change"] == "created" {
				sawCreated = true
			}
		}
		if !sawCreated {
			time.Sleep(300 * time.Millisecond)
		}
	}
	if !sawCreated {
		t.Fatal("expected a 'created' /v1/me/changes row for the remembered entry")
	}

	// ── 7. Metrics + metrics/history respond with sane shapes ──────
	metrics := API(t, "/v1/me/metrics", Opts{})
	if metrics.Status != 200 {
		t.Fatalf("metrics status = %d, want 200", metrics.Status)
	}
	metrics.Obj(t) // expect(typeof metrics.body).toBe("object")

	history := API(t, "/v1/me/metrics/history?hours=1", Opts{})
	if history.Status != 200 {
		t.Fatalf("metrics/history status = %d, want 200", history.Status)
	}
	historyBody := history.MustValidate(t, MetricsHistoryResponse)
	if historyBody["hours"] != float64(1) {
		t.Fatalf("history hours = %v, want 1", historyBody["hours"])
	}

	// ── 8. Onboarding responds, reflecting a USER-GLOBAL remember ──
	// /v1/me/onboarding derives `remembered` from recent(user, {k:1})
	// with NO project scope — on both servers — so the project-scoped
	// write above does not set it. Long-lived accounts on the oracle
	// happen to have user-global rows, which masked this; a fresh
	// account does not. Write one explicitly so the assertion tests
	// the endpoint rather than the account's history.
	onboarding := API(t, "/v1/me/onboarding", Opts{})
	if onboarding.Status != 200 {
		t.Fatalf("onboarding status = %d, want 200", onboarding.Status)
	}
	onboardingBody := onboarding.MustValidate(t, OnboardingResponse)
	if onboardingBody["userExists"] != true {
		t.Fatalf("onboarding userExists = %v, want true", onboardingBody["userExists"])
	}
	if onboardingBody["remembered"] != true {
		t.Fatalf("onboarding remembered = %v, want true", onboardingBody["remembered"])
	}

	// ── 9. Usage: entry count + effective quota ─────────────────────
	usage := API(t, "/v1/me/usage", Opts{})
	if usage.Status != 200 {
		t.Fatalf("usage status = %d, want 200", usage.Status)
	}
	usageBody := usage.MustValidate(t, UsageResponse)
	if usageBody["entries"].(float64) <= 0 {
		t.Fatalf("usage entries = %v, want > 0", usageBody["entries"])
	}

	// ── 10. Export: keyset-paged dump includes our entry ────────────
	exp := API(t, "/v1/me/export?limit=1000", Opts{})
	if exp.Status != 200 {
		t.Fatalf("export status = %d, want 200", exp.Status)
	}
	expBody := exp.MustValidate(t, ExportResponse)
	sawExported := false
	for _, en := range expBody["entries"].([]any) {
		if en.(map[string]any)["id"] == entryID {
			sawExported = true
		}
	}
	if !sawExported {
		t.Fatalf("export did not include entry %s", entryID)
	}

	// ── 11. Import: round-trip one entry back in, scoped to the same
	//       project so project-delete cleans it up too. Ids are not
	//       preserved (deployment-local ULIDs) — verify via count. ──
	importContent := "conf-me import probe " + ns + ": the router firmware update is scheduled for Sunday"
	before := API(t, "/v1/me/usage", Opts{})
	imp := API(t, "/v1/me/import", Opts{
		Body: map[string]any{
			"entries": []any{
				map[string]any{"content": importContent, "namespace": ns, "project": projectID},
			},
		},
	})
	if imp.Status != 201 {
		t.Fatalf("import status = %d, want 201", imp.Status)
	}
	impBody := imp.MustValidate(t, ImportResponse)
	if impBody["imported"] != float64(1) {
		t.Fatalf("imported = %v, want 1", impBody["imported"])
	}
	if failed := impBody["failed"].([]any); len(failed) != 0 {
		t.Fatalf("failed = %v, want []", failed)
	}
	after := API(t, "/v1/me/usage", Opts{})
	// At least one, not exactly one: `/v1/me/usage` counts every entry
	// the user owns, and on a target running fact extraction the
	// chunks written earlier in this lifecycle keep landing derived
	// facts asynchronously. One of those inside this window makes the
	// count rise by two, which says nothing about whether the import
	// worked. Observed against novamem-bench: expected 209, got 210.
	if after.Field(t, "entries").(float64) < before.Field(t, "entries").(float64)+1 {
		t.Fatalf("usage entries after import = %v, want >= %v+1",
			after.Field(t, "entries"), before.Field(t, "entries"))
	}

	// The count was doing the real work, so replace it with something
	// exact rather than just looser: read the entry back and match its
	// content. Ids are deployment-local ULIDs and not preserved across
	// an export/import, which is why the original checked a count at
	// all — but the content is preserved, and that is the property
	// import actually promises.
	imported := API(t, "/v1/recent", Opts{
		Body: map[string]any{"namespace": ns, "k": 200},
	})
	if imported.Status != 200 {
		t.Fatalf("recent (imported) status = %d, want 200", imported.Status)
	}
	importedBody := imported.MustValidate(t, RecentResponse)
	sawImported := false
	for _, item := range importedBody["results"].([]any) {
		if item.(map[string]any)["content"] == importContent {
			sawImported = true
		}
	}
	if !sawImported {
		t.Fatal("the imported entry did not come back")
	}

	// ── 12. Members: single-bench-user failure contracts ────────────
	members := API(t, "/v1/me/projects/"+projectID+"/members", Opts{})
	if members.Status != 200 {
		t.Fatalf("members status = %d, want 200", members.Status)
	}
	membersBody := members.MustValidate(t, MembersResponse)
	sawOwner := false
	for _, m := range membersBody["members"].([]any) {
		mm := m.(map[string]any)
		if mm["userId"] == ownerUserID && mm["role"] == "owner" {
			sawOwner = true
		}
	}
	if !sawOwner {
		t.Fatalf("owner %s with role 'owner' not in members list", ownerUserID)
	}

	// Unknown email → 404 "unknown user" (the exact single-user-bench
	// failure contract: no second dashboard user exists to invite).
	addUnknown := API(t, "/v1/me/projects/"+projectID+"/members", Opts{
		Body: map[string]any{"username": "nobody-" + ns + "@example.invalid"},
	})
	if addUnknown.Status != 404 {
		t.Fatalf("add unknown member status = %d, want 404", addUnknown.Status)
	}
	if body := addUnknown.MustValidate(t, ErrorBody); body["error"] != "unknown user" {
		t.Fatalf("add unknown member error = %v, want %q", body["error"], "unknown user")
	}

	// The bench's only real user is the owner (e.AdminEmail) — adding
	// them by email resolves to a real user but they're already a
	// member (auto-added as owner on project create): 409.
	if e.AdminEmail != "" {
		addSelf := API(t, "/v1/me/projects/"+projectID+"/members", Opts{
			Body: map[string]any{"username": e.AdminEmail},
		})
		if addSelf.Status != 409 {
			t.Fatalf("add self status = %d, want 409", addSelf.Status)
		}
		if body := addSelf.MustValidate(t, ErrorBody); body["error"] != "user is already a member" {
			t.Fatalf("add self error = %v, want %q", body["error"], "user is already a member")
		}
	}

	// Owner cannot remove themselves via the member-removal path —
	// 400, distinct from delete-project.
	removeOwner := API(t, "/v1/me/projects/"+projectID+"/members/"+ownerUserID, Opts{Method: "DELETE"})
	if removeOwner.Status != 400 {
		t.Fatalf("remove owner status = %d, want 400", removeOwner.Status)
	}
	if body := removeOwner.MustValidate(t, ErrorBody); body["error"] != "owner cannot leave; delete the project instead" {
		t.Fatalf("remove owner error = %v, want %q", body["error"], "owner cannot leave; delete the project instead")
	}

	// ── 13. Token create → list → delete ────────────────────────────
	mint := AdminCookieAPI(t, "/v1/me/tokens", Opts{
		Body: map[string]any{"label": "conf-me-token-" + ns},
	})
	if mint.Status != 201 {
		t.Fatalf("mint token status = %d, want 201", mint.Status)
	}
	mintBody := mint.MustValidate(t, MintTokenResponse)
	plaintext := mintBody["token"].(string)
	if !strings.HasPrefix(plaintext, "nm_") {
		t.Fatalf("token = %q, want nm_ prefix", plaintext)
	}
	hash := sha256Hex(plaintext)
	mintedTokenHashes = append(mintedTokenHashes, hash)

	list := API(t, "/v1/me/tokens", Opts{})
	if list.Status != 200 {
		t.Fatalf("list tokens status = %d, want 200", list.Status)
	}
	listBody := list.MustValidate(t, TokenListResponse)
	sawToken := false
	for _, tk := range listBody["tokens"].([]any) {
		if tk.(map[string]any)["tokenHash"] == hash {
			sawToken = true
		}
	}
	if !sawToken {
		t.Fatalf("minted token hash %s not in token list", hash)
	}

	del := API(t, "/v1/me/tokens/"+hash, Opts{Method: "DELETE"})
	if del.Status != 200 {
		t.Fatalf("delete token status = %d, want 200", del.Status)
	}
	if del.Field(t, "deleted") != true {
		t.Fatalf("delete token deleted = %v, want true", del.Field(t, "deleted"))
	}
	mintedTokenHashes = mintedTokenHashes[:len(mintedTokenHashes)-1]

	// Deleting an already-deleted token hash is 404.
	delAgain := API(t, "/v1/me/tokens/"+hash, Opts{Method: "DELETE"})
	if delAgain.Status != 404 {
		t.Fatalf("re-delete token status = %d, want 404", delAgain.Status)
	}
	if body := delAgain.MustValidate(t, ErrorBody); body["error"] != "token not found" {
		t.Fatalf("re-delete token error = %v, want %q", body["error"], "token not found")
	}

	// ── 14. Clear active-project ─────────────────────────────────────
	clearActive := API(t, "/v1/me/active-project", Opts{Method: "DELETE"})
	if clearActive.Status != 204 {
		t.Fatalf("clear active-project status = %d, want 204", clearActive.Status)
	}

	getActiveAfterClear := API(t, "/v1/me/active-project", Opts{})
	if getActiveAfterClear.Status != 200 {
		t.Fatalf("get active-project (after clear) status = %d, want 200", getActiveAfterClear.Status)
	}
	if v := getActiveAfterClear.Field(t, "active"); v != nil {
		t.Fatalf("active after clear = %v, want null", v)
	}

	// ── 15. Delete project (owner only) — removes its entries too ───
	del2 := AdminCookieAPI(t, "/v1/me/projects/"+projectID, Opts{Method: "DELETE"})
	if del2.Status != 200 {
		t.Fatalf("delete project status = %d, want 200", del2.Status)
	}
	if del2.Field(t, "deleted") != true {
		t.Fatalf("delete project deleted = %v, want true", del2.Field(t, "deleted"))
	}
	if del2.Field(t, "entriesRemoved").(float64) < 2 {
		t.Fatalf("entriesRemoved = %v, want >= 2", del2.Field(t, "entriesRemoved"))
	}
	createdProjectIds = createdProjectIds[:0]

	// Deleting an already-deleted project is 404 "unknown project".
	del2Again := AdminCookieAPI(t, "/v1/me/projects/"+projectID, Opts{Method: "DELETE"})
	if del2Again.Status != 404 {
		t.Fatalf("re-delete project status = %d, want 404", del2Again.Status)
	}
	if body := del2Again.MustValidate(t, ErrorBody); body["error"] != "unknown project" {
		t.Fatalf("re-delete project error = %v, want %q", body["error"], "unknown project")
	}
}

func TestMeProjectsListsForBothIdentities(t *testing.T) {
	meSkipGuard(t)
	// "GET /v1/me/projects lists projects for both cookie and bearer identities"
	viaCookie := AdminCookieAPI(t, "/v1/me/projects", Opts{})
	if viaCookie.Status != 200 {
		t.Fatalf("projects via cookie status = %d, want 200", viaCookie.Status)
	}
	viaBearer := API(t, "/v1/me/projects", Opts{})
	if viaBearer.Status != 200 {
		t.Fatalf("projects via bearer status = %d, want 200", viaBearer.Status)
	}
}
