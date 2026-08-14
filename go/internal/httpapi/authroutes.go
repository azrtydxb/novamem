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
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/azrtydxb/novamem/go/internal/auth"
)

// Session lifetime + refresh cadence (auth-betterauth.ts session config).
const (
	sessionTTL       = 7 * 24 * time.Hour
	sessionUpdateAge = 24 * time.Hour
)

func (s *server) registerAuthRoutes(mux *http.ServeMux) {
	// NOT wrapped in withAuth: the handler authenticates itself by trying
	// to rotate the presented bearer (http.ts skips its hook for this URL).
	mux.HandleFunc("POST /v1/auth/rotate-token", s.handleRotateToken)
	if s.authMode != "user" {
		return
	}
	mux.HandleFunc("POST /api/auth/sign-in/email", s.handleSignIn)
	mux.HandleFunc("POST /api/auth/sign-out", s.handleSignOut)
	mux.HandleFunc("GET /api/auth/get-session", s.handleGetSession)
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

// trustedOrigin mirrors Better Auth's CSRF check: a request that carries
// an Origin must carry one we trust. A missing Origin (curl, server-side
// callers) passes, exactly as it does upstream.
func (s *server) trustedOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	for _, o := range s.trustedOrigins {
		if o == origin || o == "*" {
			return true
		}
	}
	return false
}

// baErr reproduces Better Auth's error body ({message, code}) — the SPA
// switches on `code`.
func baErr(w http.ResponseWriter, status int, code, message string) {
	writeJSONValue(w, status, map[string]any{"message": message, "code": code})
}

func (s *server) handleSignIn(w http.ResponseWriter, r *http.Request) {
	if !s.trustedOrigin(r) {
		baErr(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid origin")
		return
	}
	c, ok := s.meBody(w, r, false)
	if !ok {
		return
	}
	email, _ := c.str("email", true, 1, 256)
	password, _ := c.str("password", true, 1, 256)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	key := "signin:" + strings.ToLower(email)
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
	s.limiter.Clear(key)
	token, expiresAt, err := s.warm.CreateSession(ctx, u.ID, clientIP(r), r.UserAgent(), sessionTTL)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.setSessionCookie(w, token, sessionTTL)
	writeJSONValue(w, http.StatusOK, map[string]any{
		"redirect": false,
		"token":    token,
		"user": map[string]any{
			"id": u.ID, "email": u.Username, "role": u.Role,
		},
		"expiresAt": jsTime(expiresAt),
	})
}

func (s *server) handleSignOut(w http.ResponseWriter, r *http.Request) {
	if !s.trustedOrigin(r) {
		baErr(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid origin")
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
	s.setSessionCookie(w, "", -time.Hour)
	writeJSONValue(w, http.StatusOK, map[string]any{"success": true})
}

func (s *server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	u := s.sessionUser(r)
	if u == nil {
		writeJSONValue(w, http.StatusOK, nil)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{
		"session": map[string]any{"userId": u.ID},
		"user":    map[string]any{"id": u.ID, "email": u.Username, "role": u.Role},
	})
}

func (s *server) sessionCookieName() string {
	if s.secureCookies {
		return secureSessionCookie
	}
	return sessionCookie
}

func (s *server) setSessionCookie(w http.ResponseWriter, token string, maxAge time.Duration) {
	value := ""
	if token != "" {
		value = auth.SignCookie(s.cookieSecret, token)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     s.sessionCookieName(),
		Value:    value,
		Path:     "/",
		MaxAge:   int(maxAge.Seconds()),
		HttpOnly: true,
		Secure:   s.secureCookies,
		SameSite: http.SameSiteLaxMode,
	})
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
