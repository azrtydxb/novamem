package conformance

// Port of suites/60-admin.test.ts.
//
// Read-only transcription source: `packages/server/src/routes/admin.ts`
// (tokens/revoke, users CRUD, audit-log, metrics, metrics/prom),
// `http.ts` (`/v1/admin/health/deep`, `adminAuth`), and
// `routes/context.ts` (`requireAdmin`) — all read-only, never imported.
//
// The TS suite's worktree checked-out `admin.ts` predates `PUT
// /v1/admin/users/{id}/quota` (it lands on `feat/user-quotas`, not yet
// merged to this branch's base — same situation task-7 hit for
// `/v1/me/*`). `coverage.ts`'s `60-admin` manifest was seeded from the
// live oracle's `/openapi.json` and does list it, and the live oracle
// does serve it (confirmed via curl) — so its exact shape here was
// transcribed from `git show origin/feat/user-quotas:packages/server/
// src/routes/{admin,schemas}.ts`, still read-only, never imported.
//
// Two load-bearing corrections to the brief, both verified against the
// live oracle (not assumed from source alone):
//
//  1. **`NOVAMEM_TEST_TOKEN` is NOT a useful "denied" credential for this
//     suite.** On this bench it is literally the bootstrap admin's own
//     bearer — `http.ts`'s `wantsDashUser` allowlist resolves an `nm_`
//     bearer into `req.dashUser` for `/v1/admin/*` same as it does for
//     `/v1/me/*` (task-7), and this particular token belongs to the
//     admin account, so it sails through `requireAdmin` with a 200/201,
//     not a 401/403. Verified directly: `curl -H "Authorization: Bearer
//     $NOVAMEM_TEST_TOKEN" $URL/v1/admin/users` → 200 with the full user
//     list. A genuine "denied" test needs a real non-admin credential, so
//     this suite provisions a throwaway non-admin user (+ bearer) via
//     `POST /v1/admin/users` itself and uses THAT token for every
//     denied-caller assertion below; it is deleted in the same test.
//
//  2. **`POST /v1/admin/tokens/revoke` does not write an audit-log
//     entry.** Source confirms it (the handler calls
//     `ctx.warm.revokeUserToken` directly, no `ctx.audit(...)` call —
//     unlike `admin.user.create/delete/quota`, which do). Verified
//     empirically too: minted a throwaway token, revoked it, polled
//     `/v1/admin/audit-log` immediately after — no new row appeared, on
//     a bench serving audit-log entries in the same call. So this suite
//     exercises the revoke endpoint's own contract (idempotent
//     `{revoked: boolean}`) but proves the audit-log claim via the
//     `admin.user.create`/`admin.user.quota` events that the throwaway
//     user's own provisioning already produces — real, source-confirmed
//     audited actions — rather than asserting something false about
//     revoke.
//
// `/v1/admin/metrics` and `/v1/admin/metrics/prom` are fully disabled
// on this oracle (`ctx.adminDashboard`/`ctx.metrics` unset server-side):
// both 404 `{"error":"admin disabled"}` for EVERY caller, admin cookie
// included — that gate runs before `requireAdmin`. Verified live,
// repeatedly, with both credentials. The suite asserts the oracle's
// actual behavior rather than the brief's `text/plain` assumption.
//
// Every user/token this suite provisions is a throwaway created inside
// a single test and deleted before the test ends (or via a t.Cleanup
// backstop — the TS afterAll) — never the shared
// NOVAMEM_TEST_TOKEN/admin account.

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

// adminPlaneTarget is the describe.skipIf(env.authMode !== "user" ||
// !hasAdminIdentity) guard: a skip, never a silent omission.
func adminPlaneTarget(t *testing.T) Env {
	t.Helper()
	e := Target(t)
	if e.AuthMode != "user" || !e.HasAdminIdentity() {
		t.Skip(`admin plane suite needs auth mode "user" and an admin identity`)
	}
	return e
}

func TestAdminUnauthenticatedIs401AcrossEveryRequireAdminGatedRoute(t *testing.T) {
	adminPlaneTarget(t)

	getUsers := API(t, "/v1/admin/users", Opts{Token: NoAuth})
	if getUsers.Status != 401 {
		t.Fatalf("GET /v1/admin/users status = %d, want 401", getUsers.Status)
	}
	getUsers.MustValidate(t, ErrorBody)
	if v := getUsers.Field(t, "error"); v != "unauthorized" {
		t.Fatalf("GET /v1/admin/users error = %v, want unauthorized", v)
	}

	auditLog := API(t, "/v1/admin/audit-log", Opts{Token: NoAuth})
	if auditLog.Status != 401 {
		t.Fatalf("GET /v1/admin/audit-log status = %d, want 401", auditLog.Status)
	}
	if v := auditLog.Field(t, "error"); v != "unauthorized" {
		t.Fatalf("GET /v1/admin/audit-log error = %v, want unauthorized", v)
	}

	healthDeep := API(t, "/v1/admin/health/deep", Opts{Token: NoAuth})
	if healthDeep.Status != 401 {
		t.Fatalf("GET /v1/admin/health/deep status = %d, want 401", healthDeep.Status)
	}
	if v := healthDeep.Field(t, "error"); v != "unauthorized" {
		t.Fatalf("GET /v1/admin/health/deep error = %v, want unauthorized", v)
	}

	revoke := API(t, "/v1/admin/tokens/revoke", Opts{
		Token:  NoAuth,
		Method: "POST",
		Body:   map[string]any{"token": "nm_bogus"},
	})
	if revoke.Status != 401 {
		t.Fatalf("POST /v1/admin/tokens/revoke status = %d, want 401", revoke.Status)
	}
	if v := revoke.Field(t, "error"); v != "unauthorized" {
		t.Fatalf("POST /v1/admin/tokens/revoke error = %v, want unauthorized", v)
	}

	createUser := API(t, "/v1/admin/users", Opts{
		Token: NoAuth,
		Body:  map[string]any{"email": "unauth@example.com", "password": "does-not-matter"},
	})
	if createUser.Status != 401 {
		t.Fatalf("POST /v1/admin/users status = %d, want 401", createUser.Status)
	}
	if v := createUser.Field(t, "error"); v != "unauthorized" {
		t.Fatalf("POST /v1/admin/users error = %v, want unauthorized", v)
	}

	deleteUser := API(t, "/v1/admin/users/bogus-id", Opts{Token: NoAuth, Method: "DELETE"})
	if deleteUser.Status != 401 {
		t.Fatalf("DELETE /v1/admin/users/bogus-id status = %d, want 401", deleteUser.Status)
	}
	if v := deleteUser.Field(t, "error"); v != "unauthorized" {
		t.Fatalf("DELETE /v1/admin/users/bogus-id error = %v, want unauthorized", v)
	}

	putQuota := API(t, "/v1/admin/users/bogus-id/quota", Opts{
		Token:  NoAuth,
		Method: "PUT",
		Body:   map[string]any{},
	})
	if putQuota.Status != 401 {
		t.Fatalf("PUT /v1/admin/users/bogus-id/quota status = %d, want 401", putQuota.Status)
	}
	if v := putQuota.Field(t, "error"); v != "unauthorized" {
		t.Fatalf("PUT /v1/admin/users/bogus-id/quota error = %v, want unauthorized", v)
	}
}

func TestAdminMetricsRoutesFollowTheDashboardMasterSwitch(t *testing.T) {
	adminPlaneTarget(t)

	// `admin.ts` gates both routes on `ctx.adminDashboard`/`ctx.metrics`
	// BEFORE `requireAdmin`, so with the surface off they are 404 "admin
	// disabled" for EVERY caller — admin cookie included. With it on they
	// are ordinary admin routes: 401 unauthenticated, 200 for an admin.
	//
	// This test used to assert only the disabled branch ("on this
	// oracle"), which made it a configuration transcript rather than a
	// contract — it went red the moment it met a target with the
	// dashboard switched on. `dashboardEnabled` is probed rather than
	// read from env so it cannot drift from the target.
	probe := API(t, "/admin", Opts{Token: NoAuth})
	enabled := probe.Status == 200

	textPlain := regexp.MustCompile(`^text/plain`)
	applicationJSON := regexp.MustCompile(`^application/json`)

	for _, path := range []string{"/v1/admin/metrics", "/v1/admin/metrics/prom"} {
		unauth := API(t, path, Opts{Token: NoAuth})
		unauth.MustValidate(t, ErrorBody)
		cookie := AdminCookieAPI(t, path, Opts{})

		if !enabled {
			if unauth.Status != 404 {
				t.Fatalf("%s unauth status = %d, want 404", path, unauth.Status)
			}
			if v := unauth.Field(t, "error"); v != "admin disabled" {
				t.Fatalf("%s unauth error = %v, want admin disabled", path, v)
			}
			if cookie.Status != 404 {
				t.Fatalf("%s cookie status = %d, want 404", path, cookie.Status)
			}
			if v := cookie.Field(t, "error"); v != "admin disabled" {
				t.Fatalf("%s cookie error = %v, want admin disabled", path, v)
			}
			continue
		}

		if unauth.Status != 401 {
			t.Fatalf("%s unauth status = %d, want 401", path, unauth.Status)
		}
		if v := unauth.Field(t, "error"); v != "unauthorized" {
			t.Fatalf("%s unauth error = %v, want unauthorized", path, v)
		}
		if cookie.Status != 200 {
			t.Fatalf("%s cookie status = %d, want 200", path, cookie.Status)
		}
		ct := cookie.Headers.Get("Content-Type")
		if strings.HasSuffix(path, "/prom") {
			if !textPlain.MatchString(ct) {
				t.Fatalf("%s content-type = %q, want text/plain", path, ct)
			}
			body, ok := cookie.Body.(string)
			if !ok {
				t.Fatalf("%s body is %T, want string", path, cookie.Body)
			}
			// Go runtime metrics are appended after the novamem_* contract
			// lines (parity-audit item #16: goroutine visibility once Go
			// became the primary server).
			if !strings.Contains(body, "# TYPE go_goroutines gauge") {
				t.Fatalf("%s body missing go_goroutines gauge", path)
			}
		} else {
			if !applicationJSON.MatchString(ct) {
				t.Fatalf("%s content-type = %q, want application/json", path, ct)
			}
			if _, ok := cookie.Body.(map[string]any); !ok {
				t.Fatalf("%s body is %T, want object", path, cookie.Body)
			}
		}
	}
}

func TestAdminUsersListsBootstrapAdminWithAdminRole(t *testing.T) {
	e := adminPlaneTarget(t)

	r := AdminCookieAPI(t, "/v1/admin/users", Opts{})
	if r.Status != 200 {
		t.Fatalf("status = %d, want 200", r.Status)
	}
	body := r.MustValidate(t, AdminUsersResponse)
	var bootstrap map[string]any
	for _, u := range body["users"].([]any) {
		row := u.(map[string]any)
		if row["email"] == e.AdminEmail {
			bootstrap = row
			break
		}
	}
	if bootstrap == nil {
		t.Fatalf("bootstrap admin %q not in user list", e.AdminEmail)
	}
	if bootstrap["role"] != "admin" {
		t.Fatalf("bootstrap role = %v, want admin", bootstrap["role"])
	}
}

// TestAdminFullLifecycle: provision throwaway non-admin user → prove
// non-admin denial → quota → audit-log → tokens/revoke → delete.
func TestAdminFullLifecycle(t *testing.T) {
	e := adminPlaneTarget(t)
	ns := NS()
	email := "conf-60admin-" + ns + "@bench.local"

	// ── 1. Provision a throwaway non-admin user + bearer (admin cookie) ──
	create := AdminCookieAPI(t, "/v1/admin/users", Opts{
		Body: map[string]any{
			"email":      email,
			"password":   "conformance-throwaway-pw-1",
			"tokenLabel": "conf-60admin-" + ns,
		},
	})
	if create.Status != 201 {
		t.Fatalf("create user status = %d, want 201", create.Status)
	}
	createBody := create.MustValidate(t, AdminCreateUserResponse)
	userId := createBody["userId"].(string)
	nonAdminToken, _ := createBody["token"].(string)
	if nonAdminToken == "" {
		t.Fatal("create user returned no token")
	}

	// Backstop for the TS afterAll: delete the throwaway user if the
	// test bails before its own delete step. Warn-only (t.Logf), never
	// fail the test from cleanup — same posture as the TS console.warn.
	adminCookie := AdminCookie(t)
	deleted := false
	t.Cleanup(func() {
		if deleted {
			return
		}
		h := map[string]string{"Cookie": adminCookie}
		if e.Origin != "" {
			h["Origin"] = e.Origin
		}
		r, err := apiE("/v1/admin/users/"+userId, Opts{Method: "DELETE", Token: NoAuth, Headers: h})
		if err != nil {
			t.Logf("cleanup: delete admin-provisioned user %s failed: %v", userId, err)
			return
		}
		if r.Status != 200 && r.Status != 404 {
			t.Logf("cleanup: delete admin-provisioned user %s → %d %v", userId, r.Status, r.Body)
		}
	})

	// ── 2. That throwaway (non-admin, authenticated) bearer is denied on
	//      every requireAdmin-gated route — 403 "admin only", since it DOES
	//      resolve to a dashUser (just not an admin one). /v1/admin/health/
	//      deep is the one exception: it's gated by the boolean `adminAuth`
	//      helper (not `requireAdmin`), which can't distinguish "no
	//      credentials" from "credentials, wrong role" — both are 401.
	deniedUsers := API(t, "/v1/admin/users", Opts{Token: ptr(nonAdminToken)})
	if deniedUsers.Status != 403 {
		t.Fatalf("non-admin GET /v1/admin/users status = %d, want 403", deniedUsers.Status)
	}
	deniedUsers.MustValidate(t, ErrorBody)
	if v := deniedUsers.Field(t, "error"); v != "admin only" {
		t.Fatalf("non-admin GET /v1/admin/users error = %v, want admin only", v)
	}

	deniedAudit := API(t, "/v1/admin/audit-log", Opts{Token: ptr(nonAdminToken)})
	if deniedAudit.Status != 403 {
		t.Fatalf("non-admin GET /v1/admin/audit-log status = %d, want 403", deniedAudit.Status)
	}
	if v := deniedAudit.Field(t, "error"); v != "admin only" {
		t.Fatalf("non-admin GET /v1/admin/audit-log error = %v, want admin only", v)
	}

	deniedRevoke := API(t, "/v1/admin/tokens/revoke", Opts{
		Method: "POST",
		Token:  ptr(nonAdminToken),
		Body:   map[string]any{"token": "nm_bogus"},
	})
	if deniedRevoke.Status != 403 {
		t.Fatalf("non-admin POST /v1/admin/tokens/revoke status = %d, want 403", deniedRevoke.Status)
	}
	if v := deniedRevoke.Field(t, "error"); v != "admin only" {
		t.Fatalf("non-admin POST /v1/admin/tokens/revoke error = %v, want admin only", v)
	}

	deniedCreate := API(t, "/v1/admin/users", Opts{
		Token: ptr(nonAdminToken),
		Body: map[string]any{
			"email":    "should-not-be-created@example.com",
			"password": "irrelevant",
		},
	})
	if deniedCreate.Status != 403 {
		t.Fatalf("non-admin POST /v1/admin/users status = %d, want 403", deniedCreate.Status)
	}
	if v := deniedCreate.Field(t, "error"); v != "admin only" {
		t.Fatalf("non-admin POST /v1/admin/users error = %v, want admin only", v)
	}

	deniedDelete := API(t, "/v1/admin/users/"+userId, Opts{
		Method: "DELETE",
		Token:  ptr(nonAdminToken),
	})
	if deniedDelete.Status != 403 {
		t.Fatalf("non-admin DELETE /v1/admin/users/{id} status = %d, want 403", deniedDelete.Status)
	}
	if v := deniedDelete.Field(t, "error"); v != "admin only" {
		t.Fatalf("non-admin DELETE /v1/admin/users/{id} error = %v, want admin only", v)
	}

	deniedQuota := API(t, "/v1/admin/users/"+userId+"/quota", Opts{
		Method: "PUT",
		Token:  ptr(nonAdminToken),
		Body:   map[string]any{},
	})
	if deniedQuota.Status != 403 {
		t.Fatalf("non-admin PUT /v1/admin/users/{id}/quota status = %d, want 403", deniedQuota.Status)
	}
	if v := deniedQuota.Field(t, "error"); v != "admin only" {
		t.Fatalf("non-admin PUT /v1/admin/users/{id}/quota error = %v, want admin only", v)
	}

	deniedHealthDeep := API(t, "/v1/admin/health/deep", Opts{Token: ptr(nonAdminToken)})
	if deniedHealthDeep.Status != 401 {
		t.Fatalf("non-admin GET /v1/admin/health/deep status = %d, want 401", deniedHealthDeep.Status)
	}
	deniedHealthDeep.MustValidate(t, ErrorBody)
	if v := deniedHealthDeep.Field(t, "error"); v != "unauthorized" {
		t.Fatalf("non-admin GET /v1/admin/health/deep error = %v, want unauthorized", v)
	}

	// ── 3. Admin cookie succeeds where the non-admin bearer above was
	//      denied: quota round-trip on the throwaway user ─────────────
	setQuota := AdminCookieAPI(t, "/v1/admin/users/"+userId+"/quota", Opts{
		Method: "PUT",
		Body:   map[string]any{"maxEntries": 50, "writesPerMinute": 5},
	})
	if setQuota.Status != 200 {
		t.Fatalf("set quota status = %d, want 200", setQuota.Status)
	}
	quotaBody := setQuota.MustValidate(t, AdminQuotaResponse)
	if quotaBody["userId"] != userId {
		t.Fatalf("quota userId = %v, want %s", quotaBody["userId"], userId)
	}
	quota := quotaBody["quota"].(map[string]any)
	if len(quota) != 2 || quota["maxEntries"] != float64(50) || quota["writesPerMinute"] != float64(5) {
		t.Fatalf("quota = %v, want {maxEntries: 50, writesPerMinute: 5}", quota)
	}

	// ── 4. GET /v1/admin/health/deep (admin cookie) ───────────────────
	health := AdminCookieAPI(t, "/v1/admin/health/deep", Opts{})
	if health.Status != 200 {
		t.Fatalf("health/deep status = %d, want 200", health.Status)
	}
	healthBody := health.MustValidate(t, AdminHealthDeepResponse)
	if healthBody["ok"] != true {
		t.Fatalf("health/deep ok = %v, want true", healthBody["ok"])
	}

	// ── 5. GET /v1/admin/audit-log (admin cookie): contains the
	//      admin.user.create + admin.user.quota events this test just
	//      produced. Both writes are `await`ed synchronously in the route
	//      handler before it replies (unlike /v1/me/changes' fire-and-
	//      forget append, task-7), so no polling is needed here — but a
	//      short retry is kept anyway as a cheap guard against scheduling
	//      jitter under bench load.
	auditHas := func(entries []any, action string) bool {
		for _, raw := range entries {
			entry := raw.(map[string]any)
			if entry["action"] == action && entry["target"] == userId {
				return true
			}
		}
		return false
	}
	var auditEntries []any
	for attempt := 0; attempt < 5; attempt++ {
		audit := AdminCookieAPI(t, "/v1/admin/audit-log?limit=50", Opts{})
		if audit.Status != 200 {
			t.Fatalf("audit-log status = %d, want 200", audit.Status)
		}
		auditBody := audit.MustValidate(t, AdminAuditLogResponse)
		auditEntries = auditBody["entries"].([]any)
		if auditHas(auditEntries, "admin.user.create") && auditHas(auditEntries, "admin.user.quota") {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if !auditHas(auditEntries, "admin.user.create") {
		t.Fatalf("audit-log has no admin.user.create entry for %s", userId)
	}
	if !auditHas(auditEntries, "admin.user.quota") {
		t.Fatalf("audit-log has no admin.user.quota entry for %s", userId)
	}

	// ── 6. POST /v1/admin/tokens/revoke (admin cookie): mint a throwaway
	//      token via /v1/me/tokens, revoke it, verify idempotent/garbage
	//      behavior. Does NOT check for a new audit-log row — see the
	//      file-level comment: this route has no `ctx.audit` call, and a
	//      live probe confirmed no row appears after a real revoke.
	mint := AdminCookieAPI(t, "/v1/me/tokens", Opts{
		Body: map[string]any{"label": "conf-60admin-revoke-" + ns},
	})
	if mint.Status != 201 {
		t.Fatalf("mint token status = %d, want 201", mint.Status)
	}
	mintBody := mint.MustValidate(t, MintTokenResponse)
	plaintext := mintBody["token"].(string)

	revoke := AdminCookieAPI(t, "/v1/admin/tokens/revoke", Opts{
		Method: "POST",
		Body:   map[string]any{"token": plaintext},
	})
	if revoke.Status != 200 {
		t.Fatalf("revoke status = %d, want 200", revoke.Status)
	}
	revokeBody := revoke.MustValidate(t, AdminRevokeResponse)
	if revokeBody["revoked"] != true {
		t.Fatalf("revoke revoked = %v, want true", revokeBody["revoked"])
	}

	revokeAgain := AdminCookieAPI(t, "/v1/admin/tokens/revoke", Opts{
		Method: "POST",
		Body:   map[string]any{"token": plaintext},
	})
	if revokeAgain.Status != 200 {
		t.Fatalf("revoke again status = %d, want 200", revokeAgain.Status)
	}
	if v := revokeAgain.Field(t, "revoked"); v != false {
		t.Fatalf("revoke again revoked = %v, want false", v)
	}

	revokeGarbage := AdminCookieAPI(t, "/v1/admin/tokens/revoke", Opts{
		Method: "POST",
		Body:   map[string]any{"token": "nm_totally-bogus-never-existed"},
	})
	if revokeGarbage.Status != 200 {
		t.Fatalf("revoke garbage status = %d, want 200", revokeGarbage.Status)
	}
	if v := revokeGarbage.Field(t, "revoked"); v != false {
		t.Fatalf("revoke garbage revoked = %v, want false", v)
	}

	// ── 7. DELETE /v1/admin/users/{id}: dry-run, then the real delete ──
	dryRun := AdminCookieAPI(t, "/v1/admin/users/"+userId+"?dryRun=true", Opts{Method: "DELETE"})
	if dryRun.Status != 200 {
		t.Fatalf("dry-run delete status = %d, want 200", dryRun.Status)
	}
	if v := dryRun.Field(t, "dryRun"); v != true {
		t.Fatalf("dry-run dryRun = %v, want true", v)
	}
	wouldDelete, ok := dryRun.Field(t, "wouldDelete").(map[string]any)
	if !ok || wouldDelete["userId"] != userId {
		t.Fatalf("dry-run wouldDelete = %v, want {userId: %s, ...}", dryRun.Field(t, "wouldDelete"), userId)
	}

	del := AdminCookieAPI(t, "/v1/admin/users/"+userId, Opts{Method: "DELETE"})
	if del.Status != 200 {
		t.Fatalf("delete status = %d, want 200", del.Status)
	}
	delBody := del.MustValidate(t, AdminDeleteUserResponse)
	if delBody["deleted"] != true {
		t.Fatalf("delete deleted = %v, want true", delBody["deleted"])
	}
	// Deleted for real — release the t.Cleanup backstop so cleanup
	// doesn't log a spurious 404.
	deleted = true

	deleteAgain := AdminCookieAPI(t, "/v1/admin/users/"+userId, Opts{Method: "DELETE"})
	if deleteAgain.Status != 404 {
		t.Fatalf("delete again status = %d, want 404", deleteAgain.Status)
	}
	deleteAgain.MustValidate(t, ErrorBody)
	if v := deleteAgain.Field(t, "error"); v != "no such user" {
		t.Fatalf("delete again error = %v, want no such user", v)
	}

	// ── 8. Self-delete guard: checked BEFORE any deletion happens, so
	//      this is safe to call for real against the admin's own account —
	//      it never actually deletes it.
	bootstrap := AdminCookieAPI(t, "/v1/admin/users", Opts{})
	bootstrapBody := bootstrap.MustValidate(t, AdminUsersResponse)
	var adminId string
	for _, u := range bootstrapBody["users"].([]any) {
		row := u.(map[string]any)
		if row["email"] == e.AdminEmail {
			adminId = row["id"].(string)
			break
		}
	}
	if adminId == "" {
		t.Fatalf("bootstrap admin %q not in user list", e.AdminEmail)
	}
	selfDelete := AdminCookieAPI(t, "/v1/admin/users/"+adminId, Opts{Method: "DELETE"})
	if selfDelete.Status != 400 {
		t.Fatalf("self-delete status = %d, want 400", selfDelete.Status)
	}
	selfDelete.MustValidate(t, ErrorBody)
	if v := selfDelete.Field(t, "error"); v != "admins cannot delete themselves" {
		t.Fatalf("self-delete error = %v, want admins cannot delete themselves", v)
	}
}
