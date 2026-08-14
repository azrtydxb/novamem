// Auth middleware for modes none|bearer. Transcribed from http.ts's
// onRequest hook (the none/bearer branches only — mode "user" resolves
// nm_ bearers against user_tokens and is slice 5):
//   - mode none  → every request is the synthetic "public" user.
//   - mode bearer → the Authorization bearer must equal the shared token
//     (constant-time compare); missing or wrong → 401 {"error":
//     "unauthorized"}. The matched caller is the "public" user.
package httpapi

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

func (s *server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.authMode == "none" {
			next(w, r)
			return
		}
		// bearer mode.
		header := r.Header.Get("Authorization")
		token := ""
		if strings.HasPrefix(header, "Bearer ") {
			token = header[len("Bearer "):]
		}
		if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(s.authToken)) != 1 {
			s.sendError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

// userID for the request. none|bearer modes always resolve to the
// synthetic public user (http.ts: req.userId = SYSTEM_USER).
func (s *server) userID(_ *http.Request) string { return warmstore.SystemUser }
