package conformance

// Coverage maps every live endpoint to the suite file that owns it —
// the gate test in meta_test.go fails on any live endpoint missing from
// this manifest, which is what keeps the suite honest as features land.
// Transcribed verbatim from packages/conformance/src/coverage.ts.
var Coverage = map[string]string{
	// 00-meta — health/liveness/readiness + the spec itself
	"GET /health":       "00-meta",
	"GET /live":         "00-meta",
	"GET /ready":        "00-meta",
	"GET /openapi.json": "00-meta",

	// 10-data-plane — core memory CRUD
	"POST /v1/remember":     "10-data-plane",
	"POST /v1/recent":       "10-data-plane",
	"PUT /v1/memories/{id}": "10-data-plane",
	"POST /v1/forget":       "10-data-plane",
	"GET /v1/stats":         "10-data-plane",

	// 20-search — retrieval surface
	"POST /v1/search":        "20-search",
	"POST /v1/context":       "20-search",
	"GET /v1/context-prefix": "20-search",
	"POST /v1/neighbors":     "20-search",

	// 30-ingest — capture/observation pipeline + maintenance jobs
	"POST /v1/capture":       "30-ingest",
	"POST /v1/observe":       "30-ingest",
	"POST /v1/session-recap": "30-ingest",
	"POST /v1/evaluate":      "30-ingest",
	"POST /v1/hygiene":       "30-ingest",
	"POST /v1/adoption":      "30-ingest",
	"POST /v1/decay":         "30-ingest",
	"POST /v1/dream-cycle":   "30-ingest",
	"POST /v1/reap-orphans":  "30-ingest",

	// 40-auth
	"POST /v1/auth/rotate-token": "40-auth",

	// 41-better-auth — the Better Auth passthrough allow-list. Hidden
	// from /openapi.json (schema hide), claimed anyway: the manifest is
	// also the human-readable inventory, and the parity audit found 22
	// of these missing on Go under a green run precisely because
	// nothing listed them.
	"POST /api/auth/sign-in/email":              "41-better-auth",
	"POST /api/auth/sign-out":                   "41-better-auth",
	"GET /api/auth/get-session":                 "41-better-auth",
	"POST /api/auth/get-session":                "41-better-auth",
	"GET /api/auth/token":                       "41-better-auth",
	"GET /api/auth/jwks":                        "41-better-auth",
	"POST /api/auth/change-password":            "41-better-auth",
	"GET /api/auth/list-sessions":               "41-better-auth",
	"POST /api/auth/revoke-session":             "41-better-auth",
	"POST /api/auth/forget-password":            "41-better-auth",
	"POST /api/auth/reset-password":             "41-better-auth",
	"GET /api/auth/verify-email":                "41-better-auth",
	"POST /api/auth/send-verification-email":    "41-better-auth",
	"GET /api/auth/admin/list-users":            "41-better-auth",
	"POST /api/auth/admin/create-user":          "41-better-auth",
	"POST /api/auth/admin/update-user":          "41-better-auth",
	"POST /api/auth/admin/set-role":             "41-better-auth",
	"POST /api/auth/admin/set-user-password":    "41-better-auth",
	"POST /api/auth/admin/remove-user":          "41-better-auth",
	"POST /api/auth/admin/ban-user":             "41-better-auth",
	"POST /api/auth/admin/unban-user":           "41-better-auth",
	"POST /api/auth/admin/list-user-sessions":   "41-better-auth",
	"POST /api/auth/admin/revoke-user-session":  "41-better-auth",
	"POST /api/auth/admin/revoke-user-sessions": "41-better-auth",
	"POST /api/auth/admin/impersonate-user":     "41-better-auth",
	"POST /api/auth/admin/stop-impersonating":   "41-better-auth",

	// 42-dashboard — the static SPA mount + its auth-hook allow-list.
	"GET /admin":            "42-dashboard",
	"GET /admin/":           "42-dashboard",
	"GET /admin/index.html": "42-dashboard",
	"GET /admin/assets/*":   "42-dashboard",

	// 43-cors-ratelimit — middleware, not endpoints. 90-llm — subsystem
	// behaviour over routes claimed above.

	// 50-me — per-user self-service surface
	"GET /v1/me/active-project":                    "50-me",
	"PUT /v1/me/active-project":                    "50-me",
	"DELETE /v1/me/active-project":                 "50-me",
	"GET /v1/me/changes":                           "50-me",
	"GET /v1/me/export":                            "50-me",
	"POST /v1/me/import":                           "50-me",
	"GET /v1/me/metrics":                           "50-me",
	"GET /v1/me/metrics/history":                   "50-me",
	"GET /v1/me/onboarding":                        "50-me",
	"GET /v1/me/projects":                          "50-me",
	"POST /v1/me/projects":                         "50-me",
	"DELETE /v1/me/projects/{id}":                  "50-me",
	"GET /v1/me/projects/{id}/members":             "50-me",
	"POST /v1/me/projects/{id}/members":            "50-me",
	"DELETE /v1/me/projects/{id}/members/{userId}": "50-me",
	"GET /v1/me/today":                             "50-me",
	"GET /v1/me/tokens":                            "50-me",
	"POST /v1/me/tokens":                           "50-me",
	"DELETE /v1/me/tokens/{hash}":                  "50-me",
	"GET /v1/me/usage":                             "50-me",

	// 60-admin
	"GET /v1/admin/audit-log":        "60-admin",
	"GET /v1/admin/health/deep":      "60-admin",
	"GET /v1/admin/metrics":          "60-admin",
	"GET /v1/admin/metrics/prom":     "60-admin",
	"POST /v1/admin/tokens/revoke":   "60-admin",
	"POST /v1/admin/users":           "60-admin",
	"GET /v1/admin/users":            "60-admin",
	"DELETE /v1/admin/users/{id}":    "60-admin",
	"PUT /v1/admin/users/{id}/quota": "60-admin",

	// 70-mcp-streamable — single /mcp endpoint, session lifecycle
	"GET /mcp":    "70-mcp-streamable",
	"POST /mcp":   "70-mcp-streamable",
	"DELETE /mcp": "70-mcp-streamable",

	// 71-mcp-sse — legacy MCP HTTP+SSE transport
	"GET /mcp/sse":       "71-mcp-sse",
	"POST /mcp/messages": "71-mcp-sse",
}

// Exempt lists endpoints deliberately not conformance-tested; each
// needs a reason.
var Exempt = map[string]string{}
