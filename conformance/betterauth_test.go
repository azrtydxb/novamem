package conformance

// Port of suites/41-better-auth.test.ts.
//
// The Better Auth passthrough: all 25 paths on
// `packages/server/src/routes/auth.ts`'s `exactPaths` allow-list, plus
// the contract that everything else under `/api/auth/` 404s. The parity
// audit (§9.2) found 22 of these missing on the Go server under a fully
// green conformance run — this file closes that hole.
//
// Transcription sources (read-only, never imported):
//   routes/auth.ts   — the allow-list, `guardLastAdmin`
//                      (LAST_ADMIN_PROTECTED), `authLimiterKey`.
//   http.ts          — the `/api/auth/` auth-hook bypass (Better Auth
//                      owns its own auth).
//
// SAFETY. Every destructive call targets a THROWAWAY user this file
// creates and deletes; the shared admin identity is only ever *read*.
// The one exception is the LAST_ADMIN_PROTECTED probe, which by
// definition must target the sole admin — it is a 400 that deletes
// nothing, and it is skipped loudly when the target has more than one
// admin (where the same call WOULD delete a real account).
//
// The per-account auth-failure limiter is 5 strikes / 15 minutes on
// `signin:<email>` and `chgpw:<userId>`. Wrong-credential assertions
// below are therefore made ONCE each, against throwaway keys.

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

const (
	baPW  = "conf-ba-throwaway-Pw1"
	baPW2 = "conf-ba-throwaway-Pw2"
)

// Better Auth's own "no such endpoint" is an empty-bodied 404; OUR
// allow-list denial is `{"error":"not found"}`. Distinguishing them is
// the whole point of the allow-list tests.
func baIsAllowlistDenial(body any) bool {
	m, ok := body.(map[string]any)
	return ok && m["error"] == "not found"
}

type baThrowaway struct {
	id       string
	email    string
	password string
}

// baField walks nested objects; a missing/mistyped step fails the test.
func baField(t *testing.T, v any, path ...string) any {
	t.Helper()
	for i, k := range path {
		m, ok := v.(map[string]any)
		if !ok {
			raw, _ := json.Marshal(v)
			t.Fatalf("at %q: value is %T, want object: %s", strings.Join(path[:i], "."), v, raw)
		}
		v = m[k]
	}
	return v
}

func baStr(t *testing.T, v any, path ...string) string {
	t.Helper()
	got := baField(t, v, path...)
	s, _ := got.(string)
	return s
}

func baArr(t *testing.T, v any, what string) []any {
	t.Helper()
	a, ok := v.([]any)
	if !ok {
		raw, _ := json.Marshal(v)
		t.Fatalf("%s: value is %T, want array: %s", what, v, raw)
	}
	return a
}

func baDecodeJWTSegment(t *testing.T, seg string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(seg, "="))
	if err != nil {
		t.Fatalf("base64url decode: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("JWT segment is not JSON: %v", err)
	}
	return out
}

var baSessionTokenRe = regexp.MustCompile(`session_token=`)

func TestBetterAuth(t *testing.T) {
	e := Target(t)
	// Loud skip: no silent green when this run has no admin identity.
	SkipUnless(t, "user")
	if !e.HasAdminIdentity() {
		t.Skip("/api/auth/* needs auth mode=user + NOVAMEM_ADMIN_COOKIE or EMAIL+PASSWORD — skipped")
	}

	adminCk := AdminCookie(t)
	var createdUserIds []string

	// Create a throwaway user through the endpoint under test.
	createUser := func(t *testing.T, label, role string) baThrowaway {
		t.Helper()
		email := strings.ToLower("conf-ba-" + label + "-" + NS() + "@bench.local")
		r := CookieAPI(t, adminCk, "/api/auth/admin/create-user", Opts{
			Body: map[string]any{"email": email, "password": baPW, "name": label, "role": role},
		})
		if r.Status != 200 {
			raw, _ := json.Marshal(r.Body)
			t.Fatalf("create-user %s: status %d, body %s", label, r.Status, raw)
		}
		id := baStr(t, r.Body, "user", "id")
		if id == "" {
			t.Fatalf("create-user %s: no user.id", label)
		}
		if got := baStr(t, r.Body, "user", "email"); got != email {
			t.Fatalf("create-user %s: email = %q, want %q", label, got, email)
		}
		createdUserIds = append(createdUserIds, id)
		return baThrowaway{id: id, email: email, password: baPW}
	}

	t.Cleanup(func() {
		h := map[string]string{"Cookie": adminCk}
		if e.Origin != "" {
			h["Origin"] = e.Origin
		}
		for _, id := range createdUserIds {
			// DELETE /v1/admin/users/{id} also reaps the user's entries and
			// tokens; admin/remove-user only drops the account row.
			r, err := apiE("/v1/admin/users/"+id, Opts{Method: "DELETE", Token: NoAuth, Headers: h})
			if err != nil {
				t.Logf("cleanup: delete throwaway user %s failed: %v", id, err)
				continue
			}
			if r.Status != 200 && r.Status != 404 {
				raw, _ := json.Marshal(r.Body)
				t.Logf("cleanup: delete throwaway user %s → %d %s", id, r.Status, raw)
			}
		}
	})

	subject := createUser(t, "subject", "user")

	// ─── Public / unauthenticated surface ──────────────────────────────
	t.Run("/api/auth/* — public surface", func(t *testing.T) {
		t.Run("GET /api/auth/jwks publishes the session-JWT verification keys", func(t *testing.T) {
			r := API(t, "/api/auth/jwks", Opts{Token: NoAuth})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			keys := baArr(t, baField(t, r.Body, "keys"), "keys")
			if len(keys) == 0 {
				t.Fatalf("keys is empty")
			}
			for _, k := range keys {
				for _, f := range []string{"kid", "alg", "kty"} {
					if baStr(t, k, f) == "" {
						t.Fatalf("key %s is empty: %v", f, k)
					}
				}
			}
		})

		t.Run("GET /api/auth/get-session without a session is 200 with a null body", func(t *testing.T) {
			r := API(t, "/api/auth/get-session", Opts{Token: NoAuth})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			if r.Body != nil {
				t.Fatalf("body = %v, want null", r.Body)
			}
		})
	})

	// ─── Session lifecycle, driven entirely on the throwaway account ───
	t.Run("/api/auth/* — session lifecycle", func(t *testing.T) {
		var ck, secondCookie string

		t.Run("POST /api/auth/sign-in/email mints a session cookie and returns the user", func(t *testing.T) {
			r, err := SignInRaw(subject.email, subject.password)
			if err != nil {
				t.Fatalf("sign-in: %v", err)
			}
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			if baStr(t, r.Body, "token") == "" {
				t.Fatalf("token is empty")
			}
			if got := baStr(t, r.Body, "user", "id"); got != subject.id {
				t.Fatalf("user.id = %q, want %q", got, subject.id)
			}
			if got := baStr(t, r.Body, "user", "email"); got != subject.email {
				t.Fatalf("user.email = %q, want %q", got, subject.email)
			}
			ck = CookieHeaderFrom(r)
			if !baSessionTokenRe.MatchString(ck) {
				t.Fatalf("cookie %q does not match session_token=", ck)
			}
		})

		t.Run("GET /api/auth/get-session resolves that cookie to the same user", func(t *testing.T) {
			r := CookieAPI(t, ck, "/api/auth/get-session", Opts{})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			if got := baStr(t, r.Body, "session", "userId"); got != subject.id {
				t.Fatalf("session.userId = %q, want %q", got, subject.id)
			}
			if got := baStr(t, r.Body, "user", "id"); got != subject.id {
				t.Fatalf("user.id = %q, want %q", got, subject.id)
			}
		})

		t.Run("POST /api/auth/get-session is 405 — the route is mounted, the method is refused", func(t *testing.T) {
			// Mounted (our allow-list registers all five methods on every path),
			// but Better Auth itself only serves GET unless `deferSessionRefresh`
			// is on. The 405 + code is what proves the passthrough reached BA
			// rather than our own allow-list 404.
			r := CookieAPI(t, ck, "/api/auth/get-session", Opts{Body: map[string]any{}})
			if r.Status != 405 {
				t.Fatalf("status = %d, want 405", r.Status)
			}
			if got := baStr(t, r.Body, "code"); got != "METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED" {
				t.Fatalf("code = %q, want METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED", got)
			}
		})

		t.Run("GET /api/auth/token issues a verifiable session JWT", func(t *testing.T) {
			r := CookieAPI(t, ck, "/api/auth/token", Opts{})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			token := baStr(t, r.Body, "token")
			parts := strings.Split(token, ".")
			if len(parts) != 3 {
				t.Fatalf("token has %d segments, want 3", len(parts))
			}
			header := baDecodeJWTSegment(t, parts[0])
			if s, _ := header["kid"].(string); s == "" {
				t.Fatalf("JWT header kid is empty: %v", header)
			}
			claims := baDecodeJWTSegment(t, parts[1])
			if claims["email"] != subject.email {
				t.Fatalf("claims.email = %v, want %q", claims["email"], subject.email)
			}
		})

		t.Run("GET /api/auth/list-sessions lists the caller's own sessions", func(t *testing.T) {
			second := SignIn(t, subject.email, subject.password)
			r := CookieAPI(t, ck, "/api/auth/list-sessions", Opts{})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			sessions := baArr(t, r.Body, "list-sessions body")
			if len(sessions) < 2 {
				t.Fatalf("got %d sessions, want >= 2", len(sessions))
			}
			for _, s := range sessions {
				if got := baStr(t, s, "userId"); got != subject.id {
					t.Fatalf("session userId = %q, want %q", got, subject.id)
				}
			}
			// Park the second cookie for the revoke test below.
			secondCookie = second
		})

		t.Run("POST /api/auth/revoke-session kills exactly the named session", func(t *testing.T) {
			sessions := CookieAPI(t, ck, "/api/auth/list-sessions", Opts{})
			mine := CookieAPI(t, ck, "/api/auth/get-session", Opts{})
			myToken := baStr(t, mine.Body, "session", "token")
			var victim string
			for _, s := range baArr(t, sessions.Body, "list-sessions body") {
				if tok := baStr(t, s, "token"); tok != myToken {
					victim = tok
					break
				}
			}
			if victim == "" {
				t.Fatalf("need a second session to revoke")
			}

			r := CookieAPI(t, ck, "/api/auth/revoke-session", Opts{Body: map[string]any{"token": victim}})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			if got := baField(t, r.Body, "status"); got != true {
				t.Fatalf("status field = %v, want true", got)
			}

			// The revoked cookie no longer resolves; ours still does.
			dead := CookieAPI(t, secondCookie, "/api/auth/get-session", Opts{})
			if dead.Status != 200 {
				t.Fatalf("dead status = %d, want 200", dead.Status)
			}
			if dead.Body != nil {
				t.Fatalf("dead body = %v, want null", dead.Body)
			}
			alive := CookieAPI(t, ck, "/api/auth/get-session", Opts{})
			if got := baStr(t, alive.Body, "user", "id"); got != subject.id {
				t.Fatalf("alive user.id = %q, want %q", got, subject.id)
			}
		})

		t.Run("POST /api/auth/change-password rejects the wrong current password, accepts the right one", func(t *testing.T) {
			wrong := CookieAPI(t, ck, "/api/auth/change-password", Opts{
				Body: map[string]any{"currentPassword": "definitely-not-the-password", "newPassword": baPW2},
			})
			if wrong.Status != 400 {
				t.Fatalf("wrong status = %d, want 400", wrong.Status)
			}
			if got := baStr(t, wrong.Body, "code"); got != "INVALID_PASSWORD" {
				t.Fatalf("wrong code = %q, want INVALID_PASSWORD", got)
			}

			ok := CookieAPI(t, ck, "/api/auth/change-password", Opts{
				Body: map[string]any{"currentPassword": subject.password, "newPassword": baPW2},
			})
			if ok.Status != 200 {
				t.Fatalf("ok status = %d, want 200", ok.Status)
			}
			if got := baStr(t, ok.Body, "user", "id"); got != subject.id {
				t.Fatalf("ok user.id = %q, want %q", got, subject.id)
			}
			subject.password = baPW2

			// The new password really is in force.
			ck = SignIn(t, subject.email, subject.password)
		})

		t.Run("POST /api/auth/sign-out clears the session", func(t *testing.T) {
			r := CookieAPI(t, ck, "/api/auth/sign-out", Opts{Body: map[string]any{}})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			if got := baField(t, r.Body, "success"); got != true {
				t.Fatalf("success = %v, want true", got)
			}

			after := CookieAPI(t, ck, "/api/auth/get-session", Opts{})
			if after.Status != 200 {
				t.Fatalf("after status = %d, want 200", after.Status)
			}
			if after.Body != nil {
				t.Fatalf("after body = %v, want null", after.Body)
			}
		})
	})

	// ─── Admin plugin surface ──────────────────────────────────────────
	t.Run("/api/auth/admin/* — admin plugin", func(t *testing.T) {
		listUsers := func(t *testing.T) []any {
			t.Helper()
			r := CookieAPI(t, adminCk, "/api/auth/admin/list-users?limit=500", Opts{})
			if r.Status != 200 {
				t.Fatalf("list-users status = %d, want 200", r.Status)
			}
			return baArr(t, baField(t, r.Body, "users"), "users")
		}

		t.Run("GET /api/auth/admin/list-users returns the account list", func(t *testing.T) {
			users := listUsers(t)
			found := false
			for _, u := range users {
				if baStr(t, u, "id") == subject.id {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("subject %s not in list-users", subject.id)
			}
		})

		t.Run("POST /api/auth/admin/create-user provisions an account that can sign in", func(t *testing.T) {
			fresh := createUser(t, "created", "user")
			ck := SignIn(t, fresh.email, fresh.password)
			session := CookieAPI(t, ck, "/api/auth/get-session", Opts{})
			if got := baStr(t, session.Body, "user", "id"); got != fresh.id {
				t.Fatalf("user.id = %q, want %q", got, fresh.id)
			}
			if got := baStr(t, session.Body, "user", "role"); got != "user" {
				t.Fatalf("user.role = %q, want user", got)
			}
		})

		t.Run("POST /api/auth/admin/update-user edits a mutable field", func(t *testing.T) {
			r := CookieAPI(t, adminCk, "/api/auth/admin/update-user", Opts{
				Body: map[string]any{"userId": subject.id, "data": map[string]any{"name": "conformance-renamed"}},
			})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			var name any
			for _, u := range listUsers(t) {
				if baStr(t, u, "id") == subject.id {
					name = baField(t, u, "name")
					break
				}
			}
			if name != "conformance-renamed" {
				t.Fatalf("name = %v, want conformance-renamed", name)
			}
		})

		t.Run("POST /api/auth/admin/set-role promotes and demotes", func(t *testing.T) {
			promote := CookieAPI(t, adminCk, "/api/auth/admin/set-role", Opts{
				Body: map[string]any{"userId": subject.id, "role": "admin"},
			})
			if promote.Status != 200 {
				t.Fatalf("promote status = %d, want 200", promote.Status)
			}
			if got := baStr(t, promote.Body, "user", "role"); got != "admin" {
				t.Fatalf("promote role = %q, want admin", got)
			}

			demote := CookieAPI(t, adminCk, "/api/auth/admin/set-role", Opts{
				Body: map[string]any{"userId": subject.id, "role": "user"},
			})
			if demote.Status != 200 {
				t.Fatalf("demote status = %d, want 200", demote.Status)
			}
			if got := baStr(t, demote.Body, "user", "role"); got != "user" {
				t.Fatalf("demote role = %q, want user", got)
			}
		})

		t.Run("POST /api/auth/admin/set-user-password replaces a password without the old one", func(t *testing.T) {
			r := CookieAPI(t, adminCk, "/api/auth/admin/set-user-password", Opts{
				Body: map[string]any{"userId": subject.id, "newPassword": baPW},
			})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			subject.password = baPW
			// Proof, not just a 200: the new password signs in.
			ck := SignIn(t, subject.email, subject.password)
			if !baSessionTokenRe.MatchString(ck) {
				t.Fatalf("cookie %q does not match session_token=", ck)
			}
		})

		t.Run("POST /api/auth/admin/ban-user then unban-user gates and restores sign-in", func(t *testing.T) {
			ban := CookieAPI(t, adminCk, "/api/auth/admin/ban-user", Opts{
				Body: map[string]any{"userId": subject.id, "banReason": "conformance probe"},
			})
			if ban.Status != 200 {
				t.Fatalf("ban status = %d, want 200", ban.Status)
			}
			if got := baField(t, ban.Body, "user", "banned"); got != true {
				t.Fatalf("banned = %v, want true", got)
			}

			denied, err := SignInRaw(subject.email, subject.password)
			if err != nil {
				t.Fatalf("sign-in while banned: %v", err)
			}
			if denied.Status != 403 {
				t.Fatalf("denied status = %d, want 403", denied.Status)
			}
			if got := baStr(t, denied.Body, "code"); got != "BANNED_USER" {
				t.Fatalf("denied code = %q, want BANNED_USER", got)
			}

			unban := CookieAPI(t, adminCk, "/api/auth/admin/unban-user", Opts{
				Body: map[string]any{"userId": subject.id},
			})
			if unban.Status != 200 {
				t.Fatalf("unban status = %d, want 200", unban.Status)
			}
			if got := baField(t, unban.Body, "user", "banned"); got != nil && got != false {
				t.Fatalf("unbanned banned = %v, want falsy", got)
			}

			ck := SignIn(t, subject.email, subject.password)
			if !baSessionTokenRe.MatchString(ck) {
				t.Fatalf("cookie %q does not match session_token=", ck)
			}
		})

		t.Run("POST /api/auth/admin/list-user-sessions + revoke-user-session + revoke-user-sessions", func(t *testing.T) {
			a := SignIn(t, subject.email, subject.password)
			SignIn(t, subject.email, subject.password)

			listed := CookieAPI(t, adminCk, "/api/auth/admin/list-user-sessions", Opts{
				Body: map[string]any{"userId": subject.id},
			})
			if listed.Status != 200 {
				t.Fatalf("list status = %d, want 200", listed.Status)
			}
			sessions := baArr(t, baField(t, listed.Body, "sessions"), "sessions")
			if len(sessions) < 2 {
				t.Fatalf("got %d sessions, want >= 2", len(sessions))
			}
			for _, s := range sessions {
				if got := baStr(t, s, "userId"); got != subject.id {
					t.Fatalf("session userId = %q, want %q", got, subject.id)
				}
			}

			// Revoke one by token — that cookie dies, the account keeps others.
			mine := CookieAPI(t, a, "/api/auth/get-session", Opts{})
			one := CookieAPI(t, adminCk, "/api/auth/admin/revoke-user-session", Opts{
				Body: map[string]any{"sessionToken": baStr(t, mine.Body, "session", "token")},
			})
			if one.Status != 200 {
				t.Fatalf("revoke-user-session status = %d, want 200", one.Status)
			}
			dead := CookieAPI(t, a, "/api/auth/get-session", Opts{})
			if dead.Body != nil {
				t.Fatalf("dead body = %v, want null", dead.Body)
			}

			all := CookieAPI(t, adminCk, "/api/auth/admin/revoke-user-sessions", Opts{
				Body: map[string]any{"userId": subject.id},
			})
			if all.Status != 200 {
				t.Fatalf("revoke-user-sessions status = %d, want 200", all.Status)
			}
			remaining := CookieAPI(t, adminCk, "/api/auth/admin/list-user-sessions", Opts{
				Body: map[string]any{"userId": subject.id},
			})
			if left := baArr(t, baField(t, remaining.Body, "sessions"), "sessions"); len(left) != 0 {
				t.Fatalf("got %d remaining sessions, want 0", len(left))
			}
		})

		t.Run("POST /api/auth/admin/impersonate-user then stop-impersonating", func(t *testing.T) {
			imp := CookieAPI(t, adminCk, "/api/auth/admin/impersonate-user", Opts{
				Body: map[string]any{"userId": subject.id},
			})
			if imp.Status != 200 {
				t.Fatalf("impersonate status = %d, want 200", imp.Status)
			}
			if got := baStr(t, imp.Body, "user", "id"); got != subject.id {
				t.Fatalf("impersonated user.id = %q, want %q", got, subject.id)
			}
			impCk := CookieHeaderFrom(imp)
			if impCk == "" {
				t.Fatalf("impersonate returned no cookie")
			}

			// The impersonation session resolves as the target, stamped with who
			// is behind it.
			asTarget := CookieAPI(t, impCk, "/api/auth/get-session", Opts{})
			if got := baStr(t, asTarget.Body, "user", "id"); got != subject.id {
				t.Fatalf("asTarget user.id = %q, want %q", got, subject.id)
			}
			if got := baField(t, asTarget.Body, "session", "impersonatedBy"); got == nil || got == "" {
				t.Fatalf("session.impersonatedBy = %v, want truthy", got)
			}

			stop := CookieAPI(t, impCk, "/api/auth/admin/stop-impersonating", Opts{Body: map[string]any{}})
			if stop.Status != 200 {
				t.Fatalf("stop status = %d, want 200", stop.Status)
			}
		})

		t.Run("POST /api/auth/admin/remove-user deletes the account", func(t *testing.T) {
			doomed := createUser(t, "removed", "user")
			r := CookieAPI(t, adminCk, "/api/auth/admin/remove-user", Opts{
				Body: map[string]any{"userId": doomed.id},
			})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
			for i, id := range createdUserIds {
				if id == doomed.id {
					createdUserIds = append(createdUserIds[:i], createdUserIds[i+1:]...)
					break
				}
			}

			for _, u := range listUsers(t) {
				if baStr(t, u, "id") == doomed.id {
					t.Fatalf("removed user %s still listed", doomed.id)
				}
			}
		})
	})

	// ─── Endpoints that are mounted but unconfigured on this target ────
	t.Run("/api/auth/* — mounted-but-unconfigured email flows", func(t *testing.T) {
		// These four are on the allow-list, so they must NOT answer with OUR
		// `{"error":"not found"}`. What they DO answer is Better Auth's own
		// "this flow isn't wired up" — which is what proves the passthrough
		// reached Better Auth. Asserting the exact code (rather than just
		// "not our 404") is what makes this a contract rather than a smoke test.
		t.Run("POST /api/auth/forget-password is Better Auth's own 404, not the allow-list's", func(t *testing.T) {
			r := API(t, "/api/auth/forget-password", Opts{
				Body:  map[string]any{"email": "conformance-nobody@bench.local"},
				Token: NoAuth,
			})
			if r.Status != 404 {
				t.Fatalf("status = %d, want 404", r.Status)
			}
			if baIsAllowlistDenial(r.Body) {
				t.Fatalf("body is the allow-list denial: %v", r.Body)
			}
		})

		t.Run("POST /api/auth/reset-password rejects a bogus token with INVALID_TOKEN", func(t *testing.T) {
			r := API(t, "/api/auth/reset-password", Opts{
				Body:  map[string]any{"newPassword": "irrelevant-but-long-enough", "token": "conformance-bogus-token"},
				Token: NoAuth,
			})
			if r.Status != 400 {
				t.Fatalf("status = %d, want 400", r.Status)
			}
			if got := baStr(t, r.Body, "code"); got != "INVALID_TOKEN" {
				t.Fatalf("code = %q, want INVALID_TOKEN", got)
			}
		})

		t.Run("GET /api/auth/verify-email validates its query before anything else", func(t *testing.T) {
			r := API(t, "/api/auth/verify-email", Opts{Token: NoAuth})
			if r.Status != 400 {
				t.Fatalf("status = %d, want 400", r.Status)
			}
			if got := baStr(t, r.Body, "code"); got != "VALIDATION_ERROR" {
				t.Fatalf("code = %q, want VALIDATION_ERROR", got)
			}
		})

		t.Run("POST /api/auth/send-verification-email reports the flow is disabled", func(t *testing.T) {
			r := API(t, "/api/auth/send-verification-email", Opts{
				Body:  map[string]any{"email": "conformance-nobody@bench.local"},
				Token: NoAuth,
			})
			if r.Status != 400 {
				t.Fatalf("status = %d, want 400", r.Status)
			}
			if got := baStr(t, r.Body, "code"); got != "VERIFICATION_EMAIL_NOT_ENABLED" {
				t.Fatalf("code = %q, want VERIFICATION_EMAIL_NOT_ENABLED", got)
			}
		})
	})

	// ─── Contract negatives ────────────────────────────────────────────
	t.Run("/api/auth/* — allow-list and authorization negatives", func(t *testing.T) {
		t.Run("POST /api/auth/sign-up/email is 404 — open self-registration is not a supported flow", func(t *testing.T) {
			r := API(t, "/api/auth/sign-up/email", Opts{
				Body: map[string]any{
					"email":    "conf-signup-must-404-" + NS() + "@bench.local",
					"password": "should-never-be-created",
					"name":     "nope",
				},
				Token: NoAuth,
			})
			if r.Status != 404 {
				t.Fatalf("status = %d, want 404", r.Status)
			}
			if got := r.MustValidate(t, ErrorBody)["error"]; got != "not found" {
				t.Fatalf("error = %v, want \"not found\"", got)
			}
		})

		t.Run("an unknown /api/auth/* path is 404 on every method", func(t *testing.T) {
			for _, method := range []string{"GET", "POST", "PUT", "DELETE", "PATCH"} {
				o := Opts{Method: method, Token: NoAuth}
				if method != "GET" && method != "DELETE" {
					o.Body = map[string]any{}
				}
				r := API(t, "/api/auth/not-on-the-allowlist", o)
				if r.Status != 404 {
					t.Fatalf("%s /api/auth/not-on-the-allowlist: status = %d, want 404", method, r.Status)
				}
				if !baIsAllowlistDenial(r.Body) {
					raw, _ := json.Marshal(r.Body)
					t.Fatalf("%s body: %s, want the allow-list denial", method, raw)
				}
			}
		})

		t.Run("a deep unknown path under the admin subtree is 404, not a wildcard passthrough", func(t *testing.T) {
			r := API(t, "/api/auth/admin/some-new-endpoint", Opts{Body: map[string]any{}, Token: NoAuth})
			if r.Status != 404 {
				t.Fatalf("status = %d, want 404", r.Status)
			}
			if !baIsAllowlistDenial(r.Body) {
				t.Fatalf("body is not the allow-list denial: %v", r.Body)
			}
		})

		t.Run("an unauthenticated caller is refused on the admin subtree", func(t *testing.T) {
			r := API(t, "/api/auth/admin/list-users?limit=1", Opts{Token: NoAuth})
			// Better Auth answers 401 with an EMPTY body here (no `code`) — which
			// also proves it isn't our allow-list's `{"error":"not found"}`.
			if r.Status != 401 {
				t.Fatalf("status = %d, want 401", r.Status)
			}
			if baIsAllowlistDenial(r.Body) {
				t.Fatalf("body is the allow-list denial: %v", r.Body)
			}
		})

		t.Run("a signed-in NON-admin is refused on the admin subtree with the permission code", func(t *testing.T) {
			ck := SignIn(t, subject.email, subject.password)
			list := CookieAPI(t, ck, "/api/auth/admin/list-users?limit=1", Opts{})
			if list.Status != 403 {
				t.Fatalf("list status = %d, want 403", list.Status)
			}
			if got := baStr(t, list.Body, "code"); got != "YOU_ARE_NOT_ALLOWED_TO_LIST_USERS" {
				t.Fatalf("list code = %q, want YOU_ARE_NOT_ALLOWED_TO_LIST_USERS", got)
			}

			create := CookieAPI(t, ck, "/api/auth/admin/create-user", Opts{
				Body: map[string]any{
					"email":    "conf-nonadmin-" + NS() + "@bench.local",
					"password": baPW,
					"name":     "nope",
				},
			})
			if create.Status != 403 {
				t.Fatalf("create status = %d, want 403", create.Status)
			}
			if got := baStr(t, create.Body, "code"); got != "YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS" {
				t.Fatalf("create code = %q, want YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS", got)
			}
		})

		// soleAdmin returns the sole admin's user id, skipping (loudly)
		// unless there is exactly one admin.
		soleAdmin := func(t *testing.T) string {
			t.Helper()
			r := CookieAPI(t, adminCk, "/api/auth/admin/list-users?limit=500", Opts{})
			var admins []string
			for _, u := range baArr(t, baField(t, r.Body, "users"), "users") {
				if baStr(t, u, "role") == "admin" {
					admins = append(admins, baStr(t, u, "id"))
				}
			}
			if len(admins) != 1 {
				t.Skipf("target has %d admins — the guard can only be probed with exactly 1", len(admins))
			}
			return admins[0]
		}

		t.Run("LAST_ADMIN_PROTECTED blocks removing/demoting the only admin", func(t *testing.T) {
			// `guardLastAdmin` fires only when the TARGET is the sole surviving
			// admin. On a target with several admins the same call would really
			// delete one, so skip loudly rather than assert destructively.
			sole := soleAdmin(t)

			remove := CookieAPI(t, adminCk, "/api/auth/admin/remove-user", Opts{
				Body: map[string]any{"userId": sole},
			})
			if remove.Status != 400 {
				t.Fatalf("remove status = %d, want 400", remove.Status)
			}
			if got := baStr(t, remove.Body, "code"); got != "LAST_ADMIN_PROTECTED" {
				t.Fatalf("remove code = %q, want LAST_ADMIN_PROTECTED", got)
			}
			if got := baStr(t, remove.Body, "error"); got != "cannot delete the last admin — promote another user first" {
				t.Fatalf("remove error = %q", got)
			}

			demote := CookieAPI(t, adminCk, "/api/auth/admin/set-role", Opts{
				Body: map[string]any{"userId": sole, "role": "user"},
			})
			if demote.Status != 400 {
				t.Fatalf("demote status = %d, want 400", demote.Status)
			}
			if got := baStr(t, demote.Body, "code"); got != "LAST_ADMIN_PROTECTED" {
				t.Fatalf("demote code = %q, want LAST_ADMIN_PROTECTED", got)
			}
			if got := baStr(t, demote.Body, "error"); got != "cannot demote the last admin — promote another user first" {
				t.Fatalf("demote error = %q", got)
			}

			// The guard runs BEFORE Better Auth's own authorization, so it must
			// still hold — and still delete nothing — for a caller with no
			// credentials at all.
			unauth := API(t, "/api/auth/admin/remove-user", Opts{
				Body:  map[string]any{"userId": sole},
				Token: NoAuth,
			})
			if unauth.Status != 400 {
				t.Fatalf("unauth status = %d, want 400", unauth.Status)
			}
			if got := baStr(t, unauth.Body, "code"); got != "LAST_ADMIN_PROTECTED" {
				t.Fatalf("unauth code = %q, want LAST_ADMIN_PROTECTED", got)
			}

			// Proof the guard was a no-op, not a delete-then-complain.
			after := CookieAPI(t, adminCk, "/api/auth/admin/list-users?limit=500", Opts{})
			var role any
			for _, u := range baArr(t, baField(t, after.Body, "users"), "users") {
				if baStr(t, u, "id") == sole {
					role = baField(t, u, "role")
					break
				}
			}
			if role != "admin" {
				t.Fatalf("sole admin role after probe = %v, want admin", role)
			}
		})

		t.Run("setting the sole admin's role to admin is NOT blocked (no-op promotion)", func(t *testing.T) {
			sole := soleAdmin(t)
			// guardLastAdmin returns early when `role === "admin"` — the admin
			// count cannot drop, so the guard must not fire.
			r := CookieAPI(t, adminCk, "/api/auth/admin/set-role", Opts{
				Body: map[string]any{"userId": sole, "role": "admin"},
			})
			if r.Status != 200 {
				t.Fatalf("status = %d, want 200", r.Status)
			}
		})
	})

	// ─── Sign-in throttle ──────────────────────────────────────────────
	// Deliberately LAST in the file: it exhausts Better Auth's own per-IP
	// sign-in budget, and anything running after it in the same second would
	// see spurious 429s. Unlike the global rate limiter (a 1-minute window
	// that would poison the whole run, see 43-cors-ratelimit) this one is a
	// ~10-second window, so exhausting it here is cheap and self-healing.
	t.Run("/api/auth/sign-in/email — throttle", func(t *testing.T) {
		t.Run("rapid repeated sign-ins are throttled with Better Auth's own 429", func(t *testing.T) {
			// Correct credentials throughout: this proves the THROTTLE, not the
			// credential check, and leaves novamem's per-account 5-strike
			// limiter (15-minute window) untouched.
			h := map[string]string{}
			if e.Origin != "" {
				h["Origin"] = e.Origin
			}
			var throttled *Result
			for i := 0; i < 8; i++ {
				r := API(t, "/api/auth/sign-in/email", Opts{
					Body:    map[string]any{"email": subject.email, "password": subject.password},
					Token:   NoAuth,
					Headers: h,
				})
				if r.Status == 429 {
					throttled = &r
					break
				}
				if r.Status != 200 {
					t.Fatalf("status = %d, want 200", r.Status)
				}
			}
			if throttled == nil {
				t.Fatalf("8 back-to-back sign-ins were not throttled")
			}
			if got := baStr(t, throttled.Body, "message"); got != baThrottle {
				t.Fatalf("message = %q, want %q", got, baThrottle)
			}
		})
	})
}
