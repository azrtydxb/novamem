// The rest of the Better Auth allow-list (routes/auth.ts exactPaths),
// reimplemented natively over Better Auth's own tables:
//
//	GET  /api/auth/list-sessions
//	POST /api/auth/revoke-session
//	POST /api/auth/reset-password
//	GET  /api/auth/verify-email
//	POST /api/auth/send-verification-email
//	ALL  /api/auth/forget-password           (404 — see below)
//	POST /api/auth/admin/update-user
//	POST /api/auth/admin/set-user-password
//	POST /api/auth/admin/ban-user
//	POST /api/auth/admin/unban-user
//	POST /api/auth/admin/list-user-sessions
//	POST /api/auth/admin/revoke-user-session
//	POST /api/auth/admin/revoke-user-sessions
//	POST /api/auth/admin/impersonate-user
//	POST /api/auth/admin/stop-impersonating
//
// Statuses, bodies, error codes and cookie sets were captured from a
// live TS server (better-auth 1.6.26) on a scratch database and
// transcribed.
//
// Three of these are permanent error paths in this deployment, and that
// is parity, not a shortcut:
//
//   - forget-password: better-auth only mounts it when
//     `emailAndPassword.sendResetPassword` is configured. novamem
//     configures no mailer, so the route does not exist and every method
//     on it answers a bodiless 404 — which is what the allow-listed path
//     produces on the TS server today.
//   - reset-password: the only writer of a password-reset `verification`
//     row is forget-password, so no valid token can exist. Upstream's
//     lookup would therefore always miss; INVALID_TOKEN is the same
//     answer by a shorter route.
//   - send-verification-email / verify-email: with no
//     `sendVerificationEmail`, upstream rejects before it looks at
//     anything, and no verification token is ever minted.
package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/azrtydxb/novamem/go/internal/auth"
)

// impersonationTTL — the admin plugin's default
// `impersonationSessionDuration` (3600s).
const impersonationTTL = time.Hour

// Better Auth's other two cookies, under the same `nm` prefix.
const (
	adminSessionCookie   = "nm.admin_session"
	dontRememberCookie   = "nm.dont_remember"
	sessionDataCookie    = "nm.session_data"
	securePrefix         = "__Secure-"
	baValidationErrorMsg = "VALIDATION_ERROR"
)

func (s *server) registerBASessions(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/list-sessions", s.handleBAListSessions)
	mux.HandleFunc("POST /api/auth/revoke-session", s.handleBARevokeSession)
	mux.HandleFunc("POST /api/auth/reset-password", s.handleBAResetPassword)
	mux.HandleFunc("GET /api/auth/verify-email", s.handleBAVerifyEmail)
	mux.HandleFunc("POST /api/auth/send-verification-email", s.handleBASendVerification)
	mux.HandleFunc("GET /api/auth/token", s.handleBAToken)
	mux.HandleFunc("GET /api/auth/jwks", s.handleBAJWKS)

	mux.HandleFunc("POST /api/auth/admin/update-user", s.handleBAUpdateUser)
	mux.HandleFunc("POST /api/auth/admin/set-user-password", s.handleBASetUserPassword)
	mux.HandleFunc("POST /api/auth/admin/ban-user", s.handleBABanUser)
	mux.HandleFunc("POST /api/auth/admin/unban-user", s.handleBAUnbanUser)
	mux.HandleFunc("POST /api/auth/admin/list-user-sessions", s.handleBAListUserSessions)
	mux.HandleFunc("POST /api/auth/admin/revoke-user-session", s.handleBARevokeUserSession)
	mux.HandleFunc("POST /api/auth/admin/revoke-user-sessions", s.handleBARevokeUserSessions)
	mux.HandleFunc("POST /api/auth/admin/impersonate-user", s.handleBAImpersonate)
	mux.HandleFunc("POST /api/auth/admin/stop-impersonating", s.handleBAStopImpersonating)
}

// ─── validation envelope ───────────────────────────────────────────────

// better-call renders every schema failure on a route as one
// `VALIDATION_ERROR` with the issues joined by "; ", each prefixed by
// its source and path.
func baIssues(w http.ResponseWriter, msgs []string) bool {
	if len(msgs) == 0 {
		return false
	}
	baErr(w, http.StatusBadRequest, baValidationErrorMsg, strings.Join(msgs, "; "))
	return true
}

func baMissingString(field string) string {
	return "[body." + field + "] Invalid input: expected string, received undefined"
}

// z.coerce.string() reports a missing value as `nonoptional` rather than
// naming the target type.
func baMissingCoerced(field string) string {
	return "[body." + field + "] Invalid input: expected nonoptional, received undefined"
}

func baMissingRecord(field string) string {
	return "[body." + field + "] Invalid input: expected record, received undefined"
}

// coercedString is z.coerce.string(): anything present becomes its
// String() form; only absent/null fails.
func coercedString(body map[string]any, key string) (string, bool) {
	raw, ok := body[key]
	if !ok || raw == nil {
		return "", false
	}
	switch v := raw.(type) {
	case string:
		return v, true
	case bool:
		if v {
			return "true", true
		}
		return "false", true
	case float64:
		return trimFloat(v), true
	}
	return "", false
}

func trimFloat(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// ─── cookies ───────────────────────────────────────────────────────────

func (s *server) cookieName(base string) string {
	if s.secureCookies {
		return securePrefix + base
	}
	return base
}

// setSignedCookie writes a better-call signed cookie. Attribute order,
// spelling and percent-encoding are better-call's `_serialize` /
// `signCookieValue` (cookies.mjs, crypto.mjs), not net/http's — the two
// differ (`Path` before `Max-Age`, no encoding) and the header is
// contract.
//
// value == "" clears the cookie; session == true omits Max-Age so the
// cookie dies with the browser session, which is what better-auth writes
// when `dontRememberMe` is set.
func (s *server) setSignedCookie(w http.ResponseWriter, base, value string, maxAge time.Duration, session bool) {
	var b strings.Builder
	b.WriteString(s.cookieName(base))
	b.WriteByte('=')
	if value != "" {
		b.WriteString(encodeURIComponent(auth.SignCookie(s.cookieSecret, value)))
	}
	switch {
	case value == "":
		b.WriteString("; Max-Age=0")
	case session:
		// No Max-Age.
	default:
		b.WriteString("; Max-Age=")
		b.WriteString(strconv.Itoa(int(maxAge.Seconds())))
	}
	b.WriteString("; Path=/; HttpOnly")
	if s.secureCookies {
		b.WriteString("; Secure")
	}
	b.WriteString("; SameSite=Lax")
	w.Header().Add("Set-Cookie", b.String())
}

// encodeURIComponent is JavaScript's, which keeps `-_.!~*\'()` literal —
// Go's url.QueryEscape escapes more and turns spaces into `+`.
func encodeURIComponent(v string) string {
	const safe = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		c := v[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			strings.IndexByte(safe, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		const hex = "0123456789ABCDEF"
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0xf])
	}
	return b.String()
}

// signedCookie reads and verifies one of better-auth's signed cookies.
func (s *server) signedCookie(r *http.Request, base string) (string, bool) {
	for _, name := range []string{base, securePrefix + base} {
		ck, err := r.Cookie(name)
		if err != nil || ck.Value == "" {
			continue
		}
		if v, ok := auth.VerifyCookie(s.cookieSecret, cookieValue(ck.Value)); ok {
			return v, true
		}
	}
	return "", false
}

// sessionToken returns the caller's verified session token, whether or
// not it still resolves to a user.
func (s *server) sessionToken(r *http.Request) string {
	tok, _ := s.signedCookie(r, sessionCookie)
	return tok
}

// ─── core session routes ───────────────────────────────────────────────

func (s *server) handleBAListSessions(w http.ResponseWriter, r *http.Request) {
	u := s.sessionUser(r)
	if u == nil {
		baErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized")
		return
	}
	sessions, err := s.warm.ListBASessions(r.Context(), u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, sessions)
}

func (s *server) handleBARevokeSession(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	token, hasToken := body["token"].(string)
	if !hasToken {
		baIssues(w, []string{baMissingString("token")})
		return
	}
	u := s.sessionUser(r)
	if u == nil {
		// sensitiveSessionMiddleware throws APIError.fromStatus, which
		// carries both a message and a code — unlike the admin plugin's
		// bare ctx.error("UNAUTHORIZED").
		baErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized")
		return
	}
	// Upstream deletes only when the token belongs to the caller, and
	// answers {status:true} either way — no existence oracle.
	target, err := s.warm.GetBASession(r.Context(), token)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if target != nil && target.UserID == u.ID {
		if err := s.warm.DeleteSession(r.Context(), token); err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"status": true})
}

func (s *server) handleBAResetPassword(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	if _, has := body["newPassword"].(string); !has {
		baIssues(w, []string{baMissingString("newPassword")})
		return
	}
	baErr(w, http.StatusBadRequest, "INVALID_TOKEN", "Invalid token")
}

func (s *server) handleBAVerifyEmail(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("token") == "" {
		baErr(w, http.StatusBadRequest, baValidationErrorMsg,
			"[query.token] Invalid input: expected string, received undefined")
		return
	}
	baErr(w, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid token")
}

func (s *server) handleBASendVerification(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	if _, has := body["email"].(string); !has {
		baIssues(w, []string{baMissingString("email")})
		return
	}
	baErr(w, http.StatusBadRequest, "VERIFICATION_EMAIL_NOT_ENABLED",
		"Verification email isn't enabled")
}

// ─── admin plugin: the rest ────────────────────────────────────────────

func (s *server) handleBAUpdateUser(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS", "You are not allowed to update users")
	if u == nil {
		return
	}
	userID, hasID := coercedString(body, "userId")
	data, hasData := body["data"].(map[string]any)
	var msgs []string
	if !hasID {
		msgs = append(msgs, baMissingCoerced("userId"))
	}
	if !hasData {
		msgs = append(msgs, baMissingRecord("data"))
	}
	if baIssues(w, msgs) {
		return
	}
	if len(data) == 0 {
		baErr(w, http.StatusBadRequest, "NO_DATA_TO_UPDATE", "No data to update")
		return
	}
	if _, banned := data["password"]; banned {
		baErr(w, http.StatusBadRequest, "PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER",
			"Password cannot be updated through update-user. Use the set-user-password endpoint instead")
		return
	}
	if b, ok := data["banned"].(bool); ok && b && userID == u.ID {
		baErr(w, http.StatusBadRequest, "YOU_CANNOT_BAN_YOURSELF", "You cannot ban yourself")
		return
	}
	if email, ok := data["email"].(string); ok {
		email = strings.ToLower(email)
		if !looksLikeEmail(email) {
			baErr(w, http.StatusBadRequest, "INVALID_EMAIL", "Invalid email")
			return
		}
		other, err := s.warm.FindUserByExactEmail(r.Context(), email)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		if other != nil && other.ID != userID {
			baErr(w, http.StatusBadRequest, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
				"User already exists. Use another email.")
			return
		}
		data["email"] = email
	}
	if !s.baRequireUser(w, r, userID) {
		return
	}
	updated, err := s.warm.UpdateBAUser(r.Context(), userID, data)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if b, ok := data["banned"].(bool); ok && b {
		if err := s.warm.DeleteUserSessions(r.Context(), userID); err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
	}
	// update-user is the one admin route that returns the user document
	// bare rather than wrapped in {user}.
	writeJSONValue(w, http.StatusOK, updated)
}

func (s *server) handleBASetUserPassword(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD", "You are not allowed to set users password")
	if u == nil {
		return
	}
	password, hasPassword := body["newPassword"].(string)
	userID, hasID := coercedString(body, "userId")
	var msgs []string
	if !hasPassword {
		msgs = append(msgs, baMissingString("newPassword"))
	}
	if !hasID {
		msgs = append(msgs, baMissingCoerced("userId"))
	}
	if baIssues(w, msgs) {
		return
	}
	if len(password) < minPasswordLength {
		baErr(w, http.StatusBadRequest, "PASSWORD_TOO_SHORT", "Password too short")
		return
	}
	if len(password) > maxPasswordLength {
		baErr(w, http.StatusBadRequest, "PASSWORD_TOO_LONG", "Password too long")
		return
	}
	if !s.baRequireUser(w, r, userID) {
		return
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if err := s.warm.UpsertCredentialPassword(r.Context(), userID, hash); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"status": true})
}

func (s *server) handleBABanUser(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS", "You are not allowed to ban users")
	if u == nil {
		return
	}
	userID, hasID := coercedString(body, "userId")
	if !hasID {
		baIssues(w, []string{baMissingCoerced("userId")})
		return
	}
	if !s.baRequireUser(w, r, userID) {
		return
	}
	if userID == u.ID {
		baErr(w, http.StatusBadRequest, "YOU_CANNOT_BAN_YOURSELF", "You cannot ban yourself")
		return
	}
	reason, ok := body["banReason"].(string)
	if !ok || reason == "" {
		reason = "No reason"
	}
	var expires *time.Time
	if secs, ok := body["banExpiresIn"].(float64); ok && secs != 0 {
		t := time.Now().Add(time.Duration(secs) * time.Second)
		expires = &t
	}
	banned, err := s.warm.BanBAUser(r.Context(), userID, reason, expires)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if err := s.warm.DeleteUserSessions(r.Context(), userID); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"user": banned})
}

func (s *server) handleBAUnbanUser(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS", "You are not allowed to ban users")
	if u == nil {
		return
	}
	userID, hasID := coercedString(body, "userId")
	if !hasID {
		baIssues(w, []string{baMissingCoerced("userId")})
		return
	}
	if !s.baRequireUser(w, r, userID) {
		return
	}
	unbanned, err := s.warm.UnbanBAUser(r.Context(), userID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"user": unbanned})
}

func (s *server) handleBAListUserSessions(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_LIST_USERS_SESSIONS", "You are not allowed to list users sessions")
	if u == nil {
		return
	}
	userID, hasID := coercedString(body, "userId")
	if !hasID {
		baIssues(w, []string{baMissingCoerced("userId")})
		return
	}
	sessions, err := s.warm.ListBASessions(r.Context(), userID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (s *server) handleBARevokeUserSession(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS", "You are not allowed to revoke users sessions")
	if u == nil {
		return
	}
	token, hasToken := body["sessionToken"].(string)
	if !hasToken {
		baIssues(w, []string{baMissingString("sessionToken")})
		return
	}
	if err := s.warm.DeleteSession(r.Context(), token); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"success": true})
}

func (s *server) handleBARevokeUserSessions(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS", "You are not allowed to revoke users sessions")
	if u == nil {
		return
	}
	userID, hasID := coercedString(body, "userId")
	if !hasID {
		baIssues(w, []string{baMissingCoerced("userId")})
		return
	}
	if err := s.warm.DeleteUserSessions(r.Context(), userID); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"success": true})
}

func (s *server) handleBAImpersonate(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	admin := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS", "You are not allowed to impersonate users")
	if admin == nil {
		return
	}
	userID, hasID := coercedString(body, "userId")
	if !hasID {
		baIssues(w, []string{baMissingCoerced("userId")})
		return
	}
	target, err := s.warm.GetBAUser(r.Context(), userID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if target == nil {
		baErr(w, http.StatusNotFound, "USER_NOT_FOUND", "User not found")
		return
	}
	// admin({ adminRoles: ["admin"] }) and no `impersonate-admins`
	// permission on the default admin role: admins are off limits.
	if target.Role != nil && *target.Role == "admin" {
		baErr(w, http.StatusForbidden, "YOU_CANNOT_IMPERSONATE_ADMINS", "You cannot impersonate admins")
		return
	}
	adminToken := s.sessionToken(r)
	session, err := s.warm.CreateBASession(r.Context(), userID, clientIP(r), r.UserAgent(), impersonationTTL, &admin.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	dontRemember, _ := s.signedCookie(r, dontRememberCookie)
	// deleteSessionCookie() clears all three, then the new pair goes out.
	s.setSignedCookie(w, sessionCookie, "", 0, false)
	s.setSignedCookie(w, sessionDataCookie, "", 0, false)
	s.setSignedCookie(w, dontRememberCookie, "", 0, false)
	s.setSignedCookie(w, adminSessionCookie, adminToken+":"+dontRemember, sessionTTL, false)
	// setSessionCookie(ctx, …, true): dontRememberMe, so a session cookie.
	s.setSignedCookie(w, sessionCookie, session.Token, 0, true)
	s.setSignedCookie(w, dontRememberCookie, "true", 0, true)
	writeJSONValue(w, http.StatusOK, map[string]any{"session": session, "user": target})
}

func (s *server) handleBAStopImpersonating(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	if _, ok := s.baBody(w, r); !ok {
		return
	}
	token := s.sessionToken(r)
	current, err := s.warm.GetBASession(r.Context(), token)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if token == "" || current == nil {
		baUnauthorized(w)
		return
	}
	if current.ImpersonatedBy == nil {
		// APIError.fromStatus with a bare message: no `code` field at all.
		baErr(w, http.StatusBadRequest, "", "You are not impersonating anyone")
		return
	}
	adminCookie, ok := s.signedCookie(r, adminSessionCookie)
	if !ok {
		baErr(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to find admin session")
		return
	}
	adminToken, dontRemember, _ := strings.Cut(adminCookie, ":")
	adminSession, err := s.warm.GetBASession(r.Context(), adminToken)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if adminSession == nil || adminSession.UserID != *current.ImpersonatedBy {
		baErr(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to find admin session")
		return
	}
	adminUser, err := s.warm.GetBAUser(r.Context(), adminSession.UserID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if err := s.warm.DeleteSession(r.Context(), token); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.setSignedCookie(w, sessionCookie, adminToken, sessionTTL, dontRemember != "")
	s.setSignedCookie(w, adminSessionCookie, "", 0, false)
	writeJSONValue(w, http.StatusOK, map[string]any{"session": adminSession, "user": adminUser})
}

// baRequireUser is the `findUserById` existence check every admin
// mutation makes before it writes. Returns false when it has answered.
func (s *server) baRequireUser(w http.ResponseWriter, r *http.Request, id string) bool {
	u, err := s.warm.GetBAUser(r.Context(), id)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return false
	}
	if u == nil {
		baErr(w, http.StatusNotFound, "USER_NOT_FOUND", "User not found")
		return false
	}
	return true
}
