// CORS — http.ts's @fastify/cors registration (v11.3.0 defaults) over
// the NOVAMEM_CORS_ORIGINS allow-list:
//
//	unset / ""     → CORS off: no headers, OPTIONS falls through to the
//	                 catch-all 404 envelope.
//	"*"            → reflect-any: `access-control-allow-origin: *`, no
//	                 Vary, and credentials deliberately OFF (http.ts
//	                 refuses the wildcard+credentials combination).
//	explicit list  → echo the origin when it is on the list, always
//	                 `vary: Origin`, credentials on.
//
// Verified against the TS server, including the parts that read as
// quirks: `access-control-allow-credentials` is emitted even for an
// origin that is NOT on the list (only `-allow-origin` is withheld, so
// the browser rejects the response), the preflight answers 204 for
// unknown paths too, and an OPTIONS without `Access-Control-Request-Method`
// is a 400 text/plain "Invalid Preflight Request" (strictPreflight).
package httpapi

import "net/http"

// corsMethods is @fastify/cors v11's default `methods`.
const corsMethods = "GET,HEAD,POST"

func (s *server) cors(next http.Handler) http.Handler {
	if len(s.corsOrigins) == 0 {
		return next
	}
	wildcard := len(s.corsOrigins) == 1 && s.corsOrigins[0] == "*"
	allowed := make(map[string]bool, len(s.corsOrigins))
	for _, o := range s.corsOrigins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		origin := r.Header.Get("Origin")
		if wildcard {
			h.Set("Access-Control-Allow-Origin", "*")
		} else {
			h.Set("Vary", "Origin")
			if origin != "" && allowed[origin] {
				h.Set("Access-Control-Allow-Origin", origin)
			}
			h.Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method != http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		// ─── Preflight ───────────────────────────────────────────────
		if origin == "" || r.Header.Get("Access-Control-Request-Method") == "" {
			setHardeningHeaders(w)
			h.Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("Invalid Preflight Request"))
			return
		}
		// One combined Vary header, as Fastify emits it.
		if wildcard {
			h.Set("Vary", "Access-Control-Request-Headers")
		} else {
			h.Set("Vary", "Origin, Access-Control-Request-Headers")
		}
		h.Set("Access-Control-Allow-Methods", corsMethods)
		if req := r.Header.Get("Access-Control-Request-Headers"); req != "" {
			h.Set("Access-Control-Allow-Headers", req)
		}
		setHardeningHeaders(w)
		h.Set("Content-Length", "0")
		w.WriteHeader(http.StatusNoContent)
	})
}
