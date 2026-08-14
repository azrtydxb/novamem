// The five /api/auth/* endpoints packages/admin-ui actually calls,
// reimplemented natively over Better Auth's own tables:
//
//	GET  /api/auth/admin/list-users   (UsersPage)
//	POST /api/auth/admin/create-user  (UsersPage)
//	POST /api/auth/admin/set-role     (UsersPage)
//	POST /api/auth/admin/remove-user  (UsersPage)
//	POST /api/auth/change-password    (ChangePasswordPage)
//
// Statuses, bodies and error codes were captured from a live TS server
// running the same Better Auth version (1.6.26) against a scratch
// database, then transcribed. Two behaviours come from novamem's own
// passthrough wrapper (routes/auth.ts) rather than Better Auth:
//
//   - guardLastAdmin: remove-user, and set-role demotions, refuse to
//     leave the deployment with zero admins (400 LAST_ADMIN_PROTECTED).
//     It runs BEFORE the session check, as it does in TS.
//   - the per-account attempt limiter on change-password (5 failures per
//     15 minutes, keyed on the caller's user id, ip when anonymous).
//
// Deliberate divergence: Better Auth 403s a POST that carries no Origin
// header at all (MISSING_OR_NULL_ORIGIN). This server keeps the stance
// its existing sign-in/sign-out handlers already take — a request with
// no Origin (curl, a server-side caller) passes, one with an untrusted
// Origin is refused. Browsers always send it, so the dashboard sees no
// difference.
package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/auth"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// Better Auth password bounds (auth-betterauth.ts emailAndPassword).
const (
	minPasswordLength = 8
	maxPasswordLength = 256
)

func (s *server) registerAuthAdmin(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/admin/list-users", s.handleBAListUsers)
	mux.HandleFunc("POST /api/auth/admin/create-user", s.handleBACreateUser)
	mux.HandleFunc("POST /api/auth/admin/set-role", s.handleBASetRole)
	mux.HandleFunc("POST /api/auth/admin/remove-user", s.handleBARemoveUser)
	mux.HandleFunc("POST /api/auth/change-password", s.handleBAChangePassword)
}

// baBody decodes the JSON object body. Better Auth answers a body it
// can't parse with its own validation envelope rather than the Zod one
// the /v1 plane uses.
func (s *server) baBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	raw, ok := readBody(w, r)
	if !ok {
		return nil, false
	}
	m, err := decodeBody(raw, true)
	if err != nil {
		baErr(w, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid body")
		return nil, false
	}
	return m, true
}

// baUnauthorized is the admin plugin's `ctx.error("UNAUTHORIZED")`: a
// bare 401 with no body.
func baUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	setHardeningHeaders(w)
	w.WriteHeader(http.StatusUnauthorized)
}

// baAdmin resolves the session and enforces the admin role, replying
// with Better Auth's own shapes when it can't.
func (s *server) baAdmin(w http.ResponseWriter, r *http.Request, deniedCode, deniedMessage string) *warmstore.User {
	u := s.sessionUser(r)
	if u == nil {
		baUnauthorized(w)
		return nil
	}
	if u.Role != "admin" {
		baErr(w, http.StatusForbidden, deniedCode, deniedMessage)
		return nil
	}
	return u
}

// baValidation is better-call's body-schema rejection.
func baValidation(w http.ResponseWriter, field string) {
	baErr(w, http.StatusBadRequest, "VALIDATION_ERROR",
		"[body."+field+"] Invalid input: expected string, received undefined")
}

func (s *server) handleBAListUsers(w http.ResponseWriter, r *http.Request) {
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_LIST_USERS", "You are not allowed to list users")
	if u == nil {
		return
	}
	// `Number(x) || undefined` — anything unparseable (or 0) is "unset".
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	users, total, err := s.warm.ListBAUsers(r.Context(), limit, offset)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	body := map[string]any{"users": users, "total": total}
	if limit > 0 {
		body["limit"] = limit
	}
	if offset > 0 {
		body["offset"] = offset
	}
	writeJSONValue(w, http.StatusOK, body)
}

func (s *server) handleBACreateUser(w http.ResponseWriter, r *http.Request) {
	if !s.trustedOrigin(r) {
		baErr(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid origin")
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS", "You are not allowed to create users")
	if u == nil {
		return
	}
	email, _ := body["email"].(string)
	name, hasName := body["name"].(string)
	password, _ := body["password"].(string)
	if email == "" {
		baValidation(w, "email")
		return
	}
	if !hasName {
		baValidation(w, "name")
		return
	}
	role, _ := body["role"].(string)
	if role == "" {
		role = "user" // admin({ defaultRole: "user" })
	}
	email = strings.ToLower(email)
	if !looksLikeEmail(email) {
		baErr(w, http.StatusBadRequest, "INVALID_EMAIL", "Invalid email")
		return
	}
	created, err := s.warm.CreateBAUser(r.Context(), email, name, password, role)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if created == nil {
		baErr(w, http.StatusBadRequest, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
			"User already exists. Use another email.")
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"user": created})
}

func (s *server) handleBASetRole(w http.ResponseWriter, r *http.Request) {
	if !s.trustedOrigin(r) {
		baErr(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid origin")
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	userID, _ := body["userId"].(string)
	role, hasRole := body["role"].(string)
	// guardLastAdmin runs before the session check, as in routes/auth.ts.
	if userID != "" && role != "admin" && !s.guardLastAdmin(w, r, userID, "demote") {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE", "You are not allowed to change users role")
	if u == nil {
		return
	}
	if userID == "" {
		baValidation(w, "userId")
		return
	}
	if !hasRole {
		baValidation(w, "role")
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
	updated, err := s.warm.SetBAUserRole(r.Context(), userID, role)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *server) handleBARemoveUser(w http.ResponseWriter, r *http.Request) {
	if !s.trustedOrigin(r) {
		baErr(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid origin")
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	userID, _ := body["userId"].(string)
	if userID != "" && !s.guardLastAdmin(w, r, userID, "delete") {
		return
	}
	u := s.baAdmin(w, r, "YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS", "You are not allowed to delete users")
	if u == nil {
		return
	}
	if userID == "" {
		baValidation(w, "userId")
		return
	}
	if userID == u.ID {
		baErr(w, http.StatusBadRequest, "YOU_CANNOT_REMOVE_YOURSELF", "You cannot remove yourself")
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
	if err := s.warm.DeleteBAUser(r.Context(), userID); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"success": true})
}

// guardLastAdmin refuses to leave the system with zero admins. Returns
// false when it has already answered.
func (s *server) guardLastAdmin(w http.ResponseWriter, r *http.Request, targetID, action string) bool {
	remaining, err := s.warm.CountAdminsExcept(r.Context(), targetID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return false
	}
	if remaining > 0 {
		return true
	}
	writeJSONValue(w, http.StatusBadRequest, map[string]any{
		"error": "cannot " + action + " the last admin — promote another user first",
		"code":  "LAST_ADMIN_PROTECTED",
	})
	return false
}

func (s *server) handleBAChangePassword(w http.ResponseWriter, r *http.Request) {
	if !s.trustedOrigin(r) {
		baErr(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid origin")
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	u := s.sessionUser(r)
	// routes/auth.ts keys the limiter on the caller's id, falling back to
	// the client ip so anonymous spam is still capped.
	key := "chgpw-anon:" + clientIP(r)
	if u != nil {
		key = "chgpw:" + u.ID
	}
	if retry := s.limiter.Locked(key); retry > 0 {
		s.send429(w, retry)
		return
	}
	fail := func(status int, code, message string) {
		s.limiter.RecordFailure(key)
		baErr(w, status, code, message)
	}
	if u == nil {
		fail(http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized")
		return
	}
	current, hasCurrent := body["currentPassword"].(string)
	next, hasNext := body["newPassword"].(string)
	if !hasNext {
		fail(http.StatusBadRequest, "VALIDATION_ERROR",
			"[body.newPassword] Invalid input: expected string, received undefined")
		return
	}
	if !hasCurrent {
		fail(http.StatusBadRequest, "VALIDATION_ERROR",
			"[body.currentPassword] Invalid input: expected string, received undefined")
		return
	}
	revoke, _ := body["revokeOtherSessions"].(bool)
	if len(next) < minPasswordLength {
		fail(http.StatusBadRequest, "PASSWORD_TOO_SHORT", "Password too short")
		return
	}
	if len(next) > maxPasswordLength {
		fail(http.StatusBadRequest, "PASSWORD_TOO_LONG", "Password too long")
		return
	}
	ctx := r.Context()
	stored, err := s.warm.CredentialPassword(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if stored == "" {
		fail(http.StatusBadRequest, "CREDENTIAL_ACCOUNT_NOT_FOUND", "Credential account not found")
		return
	}
	if !auth.VerifyPassword(stored, current) {
		fail(http.StatusBadRequest, "INVALID_PASSWORD", "Invalid password")
		return
	}
	hash, err := auth.HashPassword(next)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if _, err := s.warm.SetCredentialPassword(ctx, u.ID, hash); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.limiter.Clear(key)
	var token any
	if revoke {
		// Better Auth drops EVERY session for the user (including this
		// one) and issues a fresh one, so other devices are signed out.
		if err := s.warm.DeleteUserSessions(ctx, u.ID); err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		fresh, _, err := s.warm.CreateSession(ctx, u.ID, clientIP(r), r.UserAgent(), sessionTTL)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		s.setSessionCookie(w, fresh, sessionTTL)
		token = fresh
	}
	doc, err := s.warm.GetBAUser(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"token": token, "user": doc})
}

// looksLikeEmail is zod's `z.email()` in spirit: one @, something on
// each side, a dot in the domain. Postgres holds the uniqueness.
func looksLikeEmail(v string) bool {
	at := strings.IndexByte(v, '@')
	if at <= 0 || at == len(v)-1 || strings.Count(v, "@") != 1 {
		return false
	}
	domain := v[at+1:]
	dot := strings.IndexByte(domain, '.')
	return dot > 0 && dot < len(domain)-1 && !strings.ContainsAny(v, " \t")
}
