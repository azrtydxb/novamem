// Auth middleware. Transcribed from http.ts's onRequest hook, all three
// modes:
//   - none   → every request is the synthetic "public" user.
//   - bearer → the Authorization bearer must equal the shared token
//     (constant-time compare); missing or wrong → 401 {"error":
//     "unauthorized"}. The matched caller is the "public" user.
//   - user   → a Better Auth session cookie and/or an `nm_…` bearer from
//     user_tokens resolves the caller. /v1/auth/* and /v1/me/* additionally
//     require a resolved dashboard user; a RESTRICTED bearer (read-only or
//     project-confined) is fenced out of the account-management surfaces
//     entirely.
package httpapi

import (
	"context"
	"crypto/subtle"
	"net/http"
	"net/url"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/auth"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// Better Auth stores the session under `<cookiePrefix>.session_token`
// (auth-betterauth.ts: cookiePrefix "nm"), with the `__Secure-` variant
// when it is issuing Secure cookies.
const (
	sessionCookie       = "nm.session_token"
	secureSessionCookie = "__Secure-nm.session_token"
)

// caller is the resolved identity for one request — http.ts's
// req.userId / req.dashUser / req.bearerToken, carried in the context
// rather than monkey-patched onto the request.
type caller struct {
	userID string
	dash   *warmstore.User
	token  *warmstore.TokenInfo
}

type callerKey struct{}

func callerOf(r *http.Request) *caller {
	if c, ok := r.Context().Value(callerKey{}).(*caller); ok {
		return c
	}
	return &caller{userID: warmstore.SystemUser}
}

func withCaller(r *http.Request, c *caller) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), callerKey{}, c))
}

// userID for the request. none|bearer modes always resolve to the
// synthetic public user (http.ts: req.userId = SYSTEM_USER).
func (s *server) userID(r *http.Request) string { return callerOf(r).userID }

// cookieValue percent-decodes a cookie the TS server may have set:
// better-call URL-encodes the signature's base64 padding (`=` → `%3D`),
// and Go's http.Cookie hands back the raw value. PathUnescape rather
// than QueryUnescape — `+` is a base64 character, not a space. A cookie
// this server set is unencoded and passes through unchanged, so old and
// new sessions both verify (no re-login at cutover).
func cookieValue(raw string) string {
	if decoded, err := url.PathUnescape(raw); err == nil {
		return decoded
	}
	return raw
}

func bearerOf(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if strings.HasPrefix(header, "Bearer ") {
		return header[len("Bearer "):]
	}
	return ""
}

func (s *server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, ok := s.resolveCaller(w, r)
		if !ok {
			return
		}
		r = withCaller(r, c)
		sw, isStatus := w.(*statusWriter)
		next(w, r)
		if !isStatus || (sw.status >= 200 && sw.status < 300) {
			s.metrics.record(c, r.URL.Path)
		}
	}
}

func (s *server) resolveCaller(w http.ResponseWriter, r *http.Request) (*caller, bool) {
	if s.authMode == "none" {
		return &caller{userID: warmstore.SystemUser}, true
	}
	token := bearerOf(r)
	if s.authMode == "bearer" {
		if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(s.authToken)) != 1 {
			s.sendError(w, http.StatusUnauthorized, "unauthorized")
			return nil, false
		}
		return &caller{userID: warmstore.SystemUser}, true
	}

	// ─── user mode ───────────────────────────────────────────────────
	ctx := r.Context()
	c := &caller{}
	if u := s.sessionUser(r); u != nil {
		c.dash = u
	}
	// Our own `nm_…` bearer resolves to a full dashboard user (with role)
	// on the surfaces that authorize per-user. Admin routes accepting an
	// admin-owned bearer is what makes non-interactive provisioning
	// possible; the role gate still applies.
	path := r.URL.Path
	wantsDash := strings.HasPrefix(path, "/v1/auth/") ||
		strings.HasPrefix(path, "/v1/me/") ||
		strings.HasPrefix(path, "/v1/admin/")
	if wantsDash && c.dash == nil && strings.HasPrefix(token, "nm_") {
		resolved, err := s.warm.ResolveUserToken(ctx, token)
		if err != nil {
			s.sendError(w, http.StatusInternalServerError, "internal server error")
			return nil, false
		}
		if resolved != nil {
			u, err := s.warm.FindUserByID(ctx, resolved.UserID)
			if err != nil {
				s.sendError(w, http.StatusInternalServerError, "internal server error")
				return nil, false
			}
			if u != nil {
				c.dash = u
				c.token = resolved
			}
		}
	}
	if s.restrictedDenied(w, r, c) {
		return nil, false
	}
	if strings.HasPrefix(path, "/v1/auth/") || strings.HasPrefix(path, "/v1/me/") {
		if c.dash == nil {
			s.sendError(w, http.StatusUnauthorized, "unauthorized")
			return nil, false
		}
		c.userID = c.dash.ID
		return c, true
	}
	// /v1/admin/* — handlers do their own role check; the user id is
	// irrelevant there.
	if strings.HasPrefix(path, "/v1/admin/") {
		c.userID = warmstore.SystemUser
		return c, true
	}
	// Data plane. A session cookie authenticates it just as well as a
	// bearer, so the cookie-authed dashboard can call /v1/* directly.
	if c.dash != nil {
		c.userID = c.dash.ID
		return c, true
	}
	if token == "" {
		s.sendError(w, http.StatusUnauthorized, "unauthorized")
		return nil, false
	}
	resolved, err := s.warm.ResolveUserToken(ctx, token)
	if err != nil {
		s.sendError(w, http.StatusInternalServerError, "internal server error")
		return nil, false
	}
	if resolved == nil {
		s.sendError(w, http.StatusUnauthorized, "unauthorized")
		return nil, false
	}
	c.userID = resolved.UserID
	c.token = resolved
	if s.restrictedDenied(w, r, c) {
		return nil, false
	}
	return c, true
}

// sessionUser resolves a signed Better Auth session cookie, or nil.
// Signature failures and unknown/expired tokens are both "no session" —
// the route guard decides the status code.
func (s *server) sessionUser(r *http.Request) *warmstore.User {
	for _, name := range []string{sessionCookie, secureSessionCookie} {
		ck, err := r.Cookie(name)
		if err != nil || ck.Value == "" {
			continue
		}
		tok, ok := auth.VerifyCookie(s.cookieSecret, cookieValue(ck.Value))
		if !ok {
			continue
		}
		u, _, err := s.warm.SessionUser(r.Context(), tok)
		if err != nil {
			s.log.Warn("session lookup failed", "err", err)
			return nil
		}
		if u != nil {
			return u
		}
	}
	return nil
}

// restrictedDenied is http.ts's token-restriction gate. A RESTRICTED
// bearer is a credential built to be handed to a less trusted process,
// so it must not reach the account-management or admin surfaces at all —
// and a read-only one must not write. Returns true when it has already
// sent the 403.
func (s *server) restrictedDenied(w http.ResponseWriter, r *http.Request, c *caller) bool {
	if !c.token.Restricted() {
		return false
	}
	path := r.URL.Path
	if strings.HasPrefix(path, "/v1/admin/") || strings.HasPrefix(path, "/v1/auth/") {
		s.sendError(w, http.StatusForbidden, "restricted token")
		return true
	}
	// Minting is how a restricted token would otherwise escalate itself.
	if strings.HasPrefix(path, "/v1/me/tokens") && r.Method != http.MethodGet {
		s.sendError(w, http.StatusForbidden, "restricted token")
		return true
	}
	if c.token.Scope == "read_only" && r.Method != http.MethodGet {
		switch path {
		case "/v1/search", "/v1/recent", "/v1/neighbors", "/v1/context", "/v1/hygiene", "/v1/adoption":
			// Read-shaped POSTs stay allowed.
		default:
			s.sendError(w, http.StatusForbidden, "read-only token")
			return true
		}
	}
	return false
}
