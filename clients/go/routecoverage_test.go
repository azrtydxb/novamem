package novamem

// Route-coverage pin: every route in the server's OpenAPI document must be
// accounted for here — either mapped to the client method that calls it, or
// carried as an explicit non-goal with its reason. A route added to
// openapi.json without a row in this map fails the test, so growing the API
// forces a client decision instead of silently widening the gap. This map is
// also the written TS→Go surface audit: every public method of the retired
// TypeScript client (packages/client) maps to a Go method below.

import (
	"encoding/json"
	"os"
	"testing"
)

// routeMap maps "METHOD path" to the client method covering it, or to a
// "non-goal: reason" entry for routes the client deliberately does not wrap.
var routeMap = map[string]string{
	"GET /health": "Client.Health",
	"GET /live":   "non-goal: liveness probe for orchestrators, not an API client call",
	"GET /ready":  "non-goal: readiness probe for orchestrators, not an API client call",

	"POST /mcp":          "non-goal: MCP transport — spoken by MCP hosts and the shim, not the REST client",
	"GET /mcp":           "non-goal: MCP transport",
	"DELETE /mcp":        "non-goal: MCP transport",
	"POST /mcp/messages": "non-goal: MCP legacy SSE transport",
	"GET /mcp/sse":       "non-goal: MCP legacy SSE transport",

	"GET /v1/admin/audit-log":        "non-goal: dashboard-only read; add on first programmatic consumer",
	"GET /v1/admin/health/deep":      "non-goal: dashboard-only read",
	"GET /v1/admin/metrics":          "non-goal: dashboard-only read",
	"GET /v1/admin/metrics/prom":     "non-goal: Prometheus scrape target",
	"POST /v1/admin/tokens/revoke":   "Admin.RevokeUserToken",
	"POST /v1/admin/users":           "Admin.ProvisionUser",
	"GET /v1/admin/users":            "Admin.ListUsers",
	"DELETE /v1/admin/users/{id}":    "Admin.DeleteUser (dryRun=true: Admin.PreviewDeleteUser)",
	"PUT /v1/admin/users/{id}/quota": "Admin.SetUserQuota",

	"POST /v1/adoption":          "Client.Adoption",
	"POST /v1/auth/rotate-token": "non-goal: token rotation is an integration-host flow (init CLI / shim), not a client-library call",
	"POST /v1/capture":           "Client.Capture",
	"POST /v1/context":           "Client.Context",
	"GET /v1/context-prefix":     "Client.ContextPrefix",
	"POST /v1/decay":             "Client.Decay",
	"POST /v1/dream-cycle":       "non-goal: operator maintenance endpoint (admin-session gated)",
	"POST /v1/evaluate":          "Client.Evaluate",
	"POST /v1/forget":            "Client.Forget",
	"POST /v1/hygiene":           "Client.Hygiene",
	"POST /v1/neighbors":         "Client.Neighbors",
	"POST /v1/observe":           "Client.Observe",
	"POST /v1/reap-orphans":      "non-goal: operator maintenance endpoint",
	"POST /v1/recent":            "Client.Recent",
	"POST /v1/remember":          "Client.Remember",
	"POST /v1/search":            "Client.Search",
	"POST /v1/session-recap":     "Client.SessionRecap",
	"GET /v1/stats":              "Client.Stats",
	"PUT /v1/memories/{id}":      "Client.Update",

	"GET /v1/me/active-project":                    "Management.ActiveProject",
	"PUT /v1/me/active-project":                    "Management.SetActiveProject",
	"DELETE /v1/me/active-project":                 "Management.ClearActiveProject",
	"GET /v1/me/changes":                           "Management.Changes",
	"GET /v1/me/export":                            "Management.Export",
	"POST /v1/me/import":                           "Management.Import",
	"GET /v1/me/metrics":                           "non-goal: dashboard-only read",
	"GET /v1/me/metrics/history":                   "non-goal: dashboard-only read",
	"GET /v1/me/onboarding":                        "non-goal: dashboard-only read",
	"GET /v1/me/projects":                          "Management.ListProjects",
	"POST /v1/me/projects":                         "Management.CreateProject",
	"DELETE /v1/me/projects/{id}":                  "Management.DeleteProject",
	"GET /v1/me/projects/{id}/members":             "Management.ListProjectMembers",
	"POST /v1/me/projects/{id}/members":            "Management.AddProjectMember",
	"DELETE /v1/me/projects/{id}/members/{userId}": "Management.RemoveProjectMember (by username: Management.RemoveProjectMemberByUsername)",
	"GET /v1/me/today":                             "Management.Today",
	"GET /v1/me/tokens":                            "Management.ListTokens",
	"POST /v1/me/tokens":                           "Management.MintToken",
	"DELETE /v1/me/tokens/{hash}":                  "Management.RevokeToken",
	"GET /v1/me/usage":                             "Management.Usage",
}

func TestEveryOpenAPIRouteIsMappedOrDeclaredNonGoal(t *testing.T) {
	raw, err := os.ReadFile("../../docs/api/openapi.json")
	if err != nil {
		t.Skipf("openapi.json not readable outside the monorepo: %v", err)
	}
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatalf("parse openapi.json: %v", err)
	}
	seen := map[string]bool{}
	methods := map[string]string{"get": "GET", "post": "POST", "put": "PUT", "delete": "DELETE", "patch": "PATCH"}
	for path, ops := range spec.Paths {
		for op := range ops {
			m, ok := methods[op]
			if !ok {
				continue // parameters, summary, etc.
			}
			key := m + " " + path
			seen[key] = true
			if routeMap[key] == "" {
				t.Errorf("route %q is in openapi.json but not in routeMap — map it to a client method or record it as a non-goal", key)
			}
		}
	}
	for key := range routeMap {
		if !seen[key] {
			t.Errorf("routeMap entry %q no longer exists in openapi.json — remove or update it", key)
		}
	}
}
