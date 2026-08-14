// Auth endpoints for user mode:
//
//	POST /v1/auth/rotate-token   — `nm_…` self-rotation (CLI / device path)
//	POST /api/auth/sign-in/email — issues the session cookie
//	POST /api/auth/sign-out      — drops the session row + cookie
//	GET  /api/auth/get-session   — the SPA's "who am I"
//
// The three /api/auth/* shapes are Better Auth's, reproduced natively
// over Better Auth's own tables (see internal/auth for the verified hash
// and cookie formats). `sign-up/email` is deliberately absent — issue
// #56: users are admin-created, open self-registration is not a product
// flow, and the TS server doesn't expose it over HTTP either.
package httpapi

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/azrtydxb/novamem/go/internal/auth"
)

// Session lifetime + refresh cadence (auth-betterauth.ts session config).
const (
	sessionTTL       = 7 * 24 * time.Hour
	sessionUpdateAge = 24 * time.Hour
)

func (s *server) registerAuthRoutes(mux *routeMux) {
	// NOT wrapped in withAuth: the handler authenticates itself by trying
	// to rotate the presented bearer (http.ts skips its hook for this URL).
	mux.HandleFunc("POST /v1/auth/rotate-token", s.handleRotateToken)
	if s.authMode != "user" {
		return
	}
	mux.HandleFunc("POST /api/auth/sign-in/email", s.handleSignIn)
	mux.HandleFunc("POST /api/auth/sign-out", s.handleSignOut)
	mux.HandleFunc("GET /api/auth/get-session", s.handleGetSession)
	mux.HandleFunc("POST /api/auth/get-session", s.handleGetSessionPost)
	s.registerAuthAdmin(mux)
	s.registerBASessions(mux)
	// Everything else under /api/auth/ answers routes/auth.ts's
	// denyHandler: a path that is not on the allow-list gets
	// `{"error":"not found"}`, and an allow-listed path reached with a
	// method Better Auth doesn't mount gets better-call's bodiless 404.
	// `sign-up/email` lands in the first branch by design (issue #56):
	// users are admin-created, open self-registration is not a product
	// flow, and the TS server doesn't expose it either.
	mux.HandleFunc("/api/auth/", s.handleAuthDeny)
}

// baAllowlist is routes/auth.ts's exactPaths, verbatim. A path on it
// that reaches handleAuthDeny did so with an unmounted method.
var baAllowlist = map[string]bool{
	"/api/auth/sign-in/email":              true,
	"/api/auth/sign-out":                   true,
	"/api/auth/get-session":                true,
	"/api/auth/token":                      true,
	"/api/auth/jwks":                       true,
	"/api/auth/change-password":            true,
	"/api/auth/list-sessions":              true,
	"/api/auth/revoke-session":             true,
	"/api/auth/forget-password":            true,
	"/api/auth/reset-password":             true,
	"/api/auth/verify-email":               true,
	"/api/auth/send-verification-email":    true,
	"/api/auth/admin/list-users":           true,
	"/api/auth/admin/create-user":          true,
	"/api/auth/admin/update-user":          true,
	"/api/auth/admin/set-role":             true,
	"/api/auth/admin/set-user-password":    true,
	"/api/auth/admin/remove-user":          true,
	"/api/auth/admin/ban-user":             true,
	"/api/auth/admin/unban-user":           true,
	"/api/auth/admin/list-user-sessions":   true,
	"/api/auth/admin/revoke-user-session":  true,
	"/api/auth/admin/revoke-user-sessions": true,
	"/api/auth/admin/impersonate-user":     true,
	"/api/auth/admin/stop-impersonating":   true,
}

func (s *server) handleAuthDeny(w http.ResponseWriter, r *http.Request) {
	if baAllowlist[r.URL.Path] {
		// better-call's own "no such route" answer: 404, empty body.
		setHardeningHeaders(w)
		w.WriteHeader(http.StatusNotFound)
		return
	}
	s.log.Warn("[/api/auth] rejected: path not on Better Auth passthrough allowlist",
		"method", r.Method, "path", r.URL.Path)
	s.sendError(w, http.StatusNotFound, "not found")
}

// baString pulls a required z.string() field, returning better-call's
// message when it is absent or the wrong type.
func baString(body map[string]any, field string) (string, []string) {
	raw, present := body[field]
	if !present || raw == nil {
		return "", []string{baMissingString(field)}
	}
	str, ok := raw.(string)
	if !ok {
		return "", []string{"[body." + field + "] Invalid input: expected string, received " + jsonType(raw)}
	}
	return str, nil
}

// POST /api/auth/get-session is mounted but refuses without
// `session.deferSessionRefresh`, which this deployment does not set.
func (s *server) handleGetSessionPost(w http.ResponseWriter, r *http.Request) {
	baErr(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED",
		"POST method requires deferSessionRefresh to be enabled in session config")
}

func (s *server) handleRotateToken(w http.ResponseWriter, r *http.Request) {
	if s.authMode != "user" {
		s.sendError(w, http.StatusBadRequest, "rotate-token is only available in user mode")
		return
	}
	current := bearerOf(r)
	if current == "" {
		s.sendError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	// Key the per-account limiter on the presented bearer so brute force
	// against one token doesn't burn the budget for unrelated accounts.
	// Hash it so no plaintext lives in the in-memory map.
	key := "rotate:" + auth.HashToken(current)[:32]
	if retry := s.limiter.Locked(key); retry > 0 {
		s.send429(w, retry)
		return
	}
	token, userID, createdAt, err := s.warm.RotateUserToken(r.Context(), current)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if token == "" {
		s.limiter.RecordFailure(key)
		s.sendError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	s.limiter.Clear(key)
	writeJSONValue(w, http.StatusCreated, map[string]any{
		"token":     token,
		"userId":    userID,
		"createdAt": jsTime(createdAt),
		"warning":   "Store this token now — it will not be shown again. The previous token is revoked.",
	})
}

func (s *server) send429(w http.ResponseWriter, retryAfter int) {
	w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	writeJSONValue(w, http.StatusTooManyRequests, map[string]any{
		"error":      "too many failed attempts — try again later",
		"retryAfter": retryAfter,
	})
}

// baOrigin is Better Auth's originCheckMiddleware on every
// state-changing /api/auth/* request. Transcribed from
// api/middlewares/origin-check.ts `validateOrigin`:
//
//   - GET/HEAD/OPTIONS are exempt (the middleware returns early).
//   - the check only runs when the request carries a Cookie header —
//     a cookie-less caller cannot be CSRF'd, so curl and server-side
//     clients pass without an Origin.
//   - the value is `Origin`, falling back to `Referer`.
//   - absent or literal "null" → MISSING_OR_NULL_ORIGIN; present but
//     untrusted → INVALID_ORIGIN.
//
// Returns false when it has already answered.
func (s *server) baOrigin(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Cookie") == "" {
		return true
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = r.Header.Get("Referer")
	}
	if origin == "" || origin == "null" {
		baErr(w, http.StatusForbidden, "MISSING_OR_NULL_ORIGIN", "Missing or null Origin")
		return false
	}
	for _, o := range s.trustedOrigins {
		if o == origin || o == "*" {
			return true
		}
	}
	baErr(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid origin")
	return false
}

// baErr reproduces Better Auth's error body — `{message, code}` in that
// order (the SPA switches on `code`). An empty code omits the field,
// which is what APIError.fromStatus produces when it is given only a
// message.
func baErr(w http.ResponseWriter, status int, code, message string) {
	body := obj{{"message", message}}
	if code != "" {
		body = append(body, kv{"code", code})
	}
	writeJSONValue(w, status, body)
}

// baRateLimit is Better Auth's rate limiter: a fixed window per
// (IP, path), refused with a bare `message` body and an `x-retry-after`
// header carrying whole seconds left in the window. Measured against
// the live TS server: three sign-ins pass, the fourth answers
// 429 {"message":"Too many requests. Please try again later."}
// with `x-retry-after: 4` six seconds into a ten-second window.
//
// ponytail: in-memory and per-replica, like the /v1 plane's limiter and
// like Better Auth's own default (memory) storage — N replicas means an
// effective ceiling of N x max. Move to the DB store if that matters.
type baRateLimit struct {
	mu sync.Mutex
	at map[string][]time.Time
}

// allow reports whether the request passes, and if not, the whole
// seconds a client should wait — the window remaining, rounded up.
func (b *baRateLimit) allow(key string, window time.Duration, max int) (bool, int) {
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.at == nil {
		b.at = map[string][]time.Time{}
	}
	kept := b.at[key][:0]
	for _, t := range b.at[key] {
		if now.Sub(t) < window {
			kept = append(kept, t)
		}
	}
	if len(kept) >= max {
		b.at[key] = kept
		return false, int(math.Ceil((window - now.Sub(kept[0])).Seconds()))
	}
	b.at[key] = append(kept, now)
	return true, 0
}

func (s *server) baThrottle(w http.ResponseWriter, r *http.Request, window time.Duration, max int) bool {
	ok, retry := s.baLimit.allow(clientIP(r)+" "+r.URL.Path, window, max)
	if ok {
		return true
	}
	w.Header().Set("x-retry-after", strconv.Itoa(retry))
	baErr(w, http.StatusTooManyRequests, "", "Too many requests. Please try again later.")
	return false
}

func (s *server) handleSignIn(w http.ResponseWriter, r *http.Request) {
	// Better Auth's rateLimit middleware is outermost — ahead of the
	// origin check and of any body parsing.
	if !s.baThrottle(w, r, 10*time.Second, 3) {
		return
	}
	if !s.baOrigin(w, r) {
		return
	}
	body, ok := s.baBody(w, r)
	if !ok {
		return
	}
	// better-call's envelope, not the /v1 plane's zod one: sign-in is a
	// Better Auth route and the SPA switches on `code`.
	email, msg := baString(body, "email")
	password, pmsg := baString(body, "password")
	var msgs []string
	msgs = append(msgs, msg...)
	msgs = append(msgs, pmsg...)
	if baIssues(w, msgs) {
		return
	}
	// z.email() on the lowercased address, before any lookup.
	email = strings.ToLower(email)
	if !looksLikeEmail(email) {
		baErr(w, http.StatusBadRequest, "INVALID_EMAIL", "Invalid email")
		return
	}
	key := "signin:" + email
	if retry := s.limiter.Locked(key); retry > 0 {
		s.send429(w, retry)
		return
	}
	// One failure shape for "no such user" and "wrong password" — a
	// distinguishable answer is a user-enumeration oracle.
	fail := func() {
		s.limiter.RecordFailure(key)
		baErr(w, http.StatusUnauthorized, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password")
	}
	ctx := r.Context()
	u, err := s.warm.FindUserByExactEmail(ctx, email)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if u == nil {
		fail()
		return
	}
	stored, err := s.warm.CredentialPassword(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if stored == "" || !auth.VerifyPassword(stored, password) {
		fail()
		return
	}
	// A banned account must not get a session. Better Auth's admin
	// plugin refuses the sign-in AFTER the password check (so a ban is
	// not a credential oracle) and lets an elapsed banExpires through.
	// Verified against the live oracle:
	//   403 {"message":"You have been banned from this application.
	//        Please contact support if you believe this is an error.",
	//        "code":"BANNED_USER"}
	// Conformance caught this: Go was minting sessions for banned users.
	if doc, derr := s.warm.GetBAUser(ctx, u.ID); derr == nil && doc != nil && doc.Banned {
		expired := doc.BanExpires != nil && *doc.BanExpires != "" && banExpired(*doc.BanExpires)
		if !expired {
			baErr(w, http.StatusForbidden, "BANNED_USER",
				"You have been banned from this application. Please contact support if you believe this is an error.")
			return
		}
	}
	s.limiter.Clear(key)
	token, _, err := s.warm.CreateSession(ctx, u.ID, clientIP(r), r.UserAgent(), sessionTTL)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.setSessionCookie(w, token, sessionTTL)
	doc, err := s.warm.GetBAUser(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{
		"redirect": false,
		"token":    token,
		"user":     doc,
	})
}

func (s *server) handleSignOut(w http.ResponseWriter, r *http.Request) {
	if !s.baOrigin(w, r) {
		return
	}
	if ck, err := r.Cookie(s.sessionCookieName()); err == nil {
		if tok, ok := auth.VerifyCookie(s.cookieSecret, cookieValue(ck.Value)); ok {
			if err := s.warm.DeleteSession(r.Context(), tok); err != nil {
				s.sendEngineErr(w, r, err)
				return
			}
		}
	}
	// deleteSessionCookie clears all three of better-auth's session
	// cookies, not just the token.
	s.setSignedCookie(w, sessionCookie, "", 0, false)
	s.setSignedCookie(w, sessionDataCookie, "", 0, false)
	s.setSignedCookie(w, dontRememberCookie, "", 0, false)
	writeJSONValue(w, http.StatusOK, map[string]any{"success": true})
}

func (s *server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	u := s.sessionUser(r)
	if u == nil {
		writeJSONValue(w, http.StatusOK, nil)
		return
	}
	ctx := r.Context()
	session, err := s.warm.GetBASession(ctx, s.sessionToken(r))
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	doc, err := s.warm.GetBAUser(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	// The jwt plugin's after-hook on /get-session: mint a JWT and expose
	// the header it rides on. Best-effort — a signing failure must not
	// turn "who am I" into a 500, which is also upstream's shape (the
	// hook throws into a handler that has already produced its body).
	if token, err := s.signUserJWT(r, doc); err == nil {
		w.Header().Set("Set-Auth-Jwt", token)
		w.Header().Set("Access-Control-Expose-Headers", "set-auth-jwt")
	} else {
		s.log.Warn("set-auth-jwt: sign failed", "err", err)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSONValue(w, http.StatusOK, map[string]any{"session": session, "user": doc})
}

func (s *server) sessionCookieName() string {
	if s.secureCookies {
		return secureSessionCookie
	}
	return sessionCookie
}

func (s *server) setSessionCookie(w http.ResponseWriter, token string, maxAge time.Duration) {
	s.setSignedCookie(w, sessionCookie, token, maxAge, false)
}

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i > 0 {
			return strings.TrimSpace(fwd[:i])
		}
		return strings.TrimSpace(fwd)
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	return host
}

// banExpired reports whether a banExpires timestamp is in the past.
// Better Auth stores it as a timestamp column; an elapsed ban lets the
// sign-in through rather than requiring an explicit unban.
func banExpired(v string) bool {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05.999999-07", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t.Before(time.Now())
		}
	}
	// Unparseable means we cannot prove the ban lapsed — keep it in force.
	return false
}
