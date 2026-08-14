// The admin plane: /v1/admin/* (tokens/revoke, users CRUD, quota,
// audit-log, metrics, metrics/prom, health/deep) plus the four
// operator-gated maintenance routes on the data plane (decay,
// dream-cycle, reap-orphans, observe).
//
// Gate semantics transcribed from routes/context.ts:
//   - requireAdmin: no credentials → 401 {"error":"unauthorized"};
//     credentials without the admin role → 403 {"error":"admin only"}.
//   - adminAuth (health/deep only): a boolean gate that cannot tell the
//     two apart, so BOTH answer 401.
//   - requireOperator: a logged-in identity is always role-checked;
//     outside user mode an anonymous caller already holds the operator
//     token by definition and passes.
//
// The metrics endpoints check the dashboard switch BEFORE the role gate,
// so with NOVAMEM_ADMIN_DASHBOARD off they are 404 "admin disabled" for
// every caller — admin cookie included.
package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/azrtydxb/novamem/go/internal/auth"
)

func (s *server) registerAdmin(mux *http.ServeMux) {
	post := func(path string, h http.HandlerFunc) { mux.HandleFunc("POST "+path, s.withAuth(h)) }
	post("/v1/admin/tokens/revoke", s.handleAdminRevoke)
	post("/v1/admin/users", s.handleAdminUserCreate)
	mux.HandleFunc("GET /v1/admin/users", s.withAuth(s.handleAdminUsers))
	mux.HandleFunc("DELETE /v1/admin/users/{id}", s.withAuth(s.handleAdminUserDelete))
	mux.HandleFunc("PUT /v1/admin/users/{id}/quota", s.withAuth(s.handleAdminQuota))
	mux.HandleFunc("GET /v1/admin/audit-log", s.withAuth(s.handleAdminAuditLog))
	mux.HandleFunc("GET /v1/admin/metrics", s.withAuth(s.handleAdminMetrics))
	mux.HandleFunc("GET /v1/admin/metrics/prom", s.withAuth(s.handleAdminMetricsProm))
	mux.HandleFunc("GET /v1/admin/health/deep", s.withAuth(s.handleAdminHealthDeep))

	// Operator-gated maintenance. These live on the data plane in the TS
	// server; they are grouped here because they share the admin gate.
	post("/v1/decay", s.handleDecay)
	post("/v1/dream-cycle", s.handleDreamCycle)
	post("/v1/reap-orphans", s.handleReapOrphans)
	post("/v1/observe", s.handleObserve)
}

// requireAdmin — the /v1/admin/* role gate. Replies and returns false
// when the caller may not proceed.
func (s *server) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	u := s.dashUser(r)
	if u == nil {
		s.sendError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	if u.Role != "admin" {
		s.sendError(w, http.StatusForbidden, "admin only")
		return false
	}
	return true
}

// requireOperator — the maintenance-route gate. A logged-in identity is
// always role-checked whatever the auth mode (a non-admin dashboard user
// must not trigger cross-user maintenance just because the server also
// allows anonymous access); outside user mode an anonymous caller has
// already presented the shared operator token.
func (s *server) requireOperator(w http.ResponseWriter, r *http.Request) bool {
	if s.dashUser(r) == nil && s.authMode != "user" {
		return true
	}
	return s.requireAdmin(w, r)
}

func (s *server) handleAdminRevoke(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	c, ok := s.meBody(w, r, false)
	if !ok {
		return
	}
	token, _ := c.str("token", true, 1, 512)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	revoked, err := s.warm.RevokeUserToken(r.Context(), token)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if revoked {
		s.metrics.ForgetToken(auth.HashToken(token))
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"revoked": revoked})
}

func (s *server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	users, err := s.warm.ListUsers(r.Context())
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"users": users})
}

func (s *server) handleAdminUserCreate(w http.ResponseWriter, r *http.Request) {
	if s.authMode != "user" {
		// No user table to provision into (admin.ts: no Better Auth
		// mounted outside user mode).
		s.sendError(w, http.StatusNotFound, "user auth not enabled")
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	c, ok := s.meBody(w, r, false)
	if !ok {
		return
	}
	email, _ := c.str("email", true, 3, 320)
	password, _ := c.str("password", true, 8, 256)
	name, hasName := c.str("name", false, 1, 128)
	tokenLabel, hasLabel := c.str("tokenLabel", false, 1, 128)
	tokenScope, _ := c.enum("tokenScope", "full", "read_only")
	tokenExpiresInDays, _ := c.positiveInt("tokenExpiresInDays", 3650)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	if !hasName || name == "" {
		// Same rationale as the bootstrap-admin sentinel: never default
		// `name` to the email — the column is not unique, and an
		// email-shaped name enables lookup confusion.
		name = "provisioned-user"
	}
	ctx := r.Context()
	userID, err := s.warm.CreateUser(ctx, email, password, name)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if userID == "" {
		s.sendError(w, http.StatusConflict, "User already exists")
		return
	}
	body := map[string]any{"userId": userID, "email": email}
	if hasLabel {
		if tokenScope == "" {
			tokenScope = "full"
		}
		var expiresAt *time.Time
		if tokenExpiresInDays > 0 {
			t := time.Now().Add(time.Duration(tokenExpiresInDays) * 24 * time.Hour)
			expiresAt = &t
		}
		token, _, err := s.warm.CreateUserToken(ctx, userID, &tokenLabel, tokenScope, nil, expiresAt)
		if err != nil {
			// A 201 without the requested token would break the caller's
			// contract, so this is a 500 with the id so they can clean up.
			writeJSONValue(w, http.StatusInternalServerError,
				map[string]any{"error": "user created but token mint failed", "userId": userID})
			return
		}
		body["token"] = token
	}
	s.audit(r, "admin.user.create", userID, map[string]any{
		"email": email, "tokenMinted": hasLabel,
	})
	writeJSONValue(w, http.StatusCreated, body)
}

func (s *server) handleAdminUserDelete(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	target, err := s.warm.FindUserByID(ctx, id)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if target == nil {
		s.sendError(w, http.StatusNotFound, "no such user")
		return
	}
	// Self-deletion is refused: the last admin removing themselves would
	// brick the deployment (bootstrap only seeds when NO admin exists).
	if s.dashUser(r).ID == id {
		s.sendError(w, http.StatusBadRequest, "admins cannot delete themselves")
		return
	}
	if isTrue(r.URL.Query().Get("dryRun")) {
		owned, err := s.warm.ListOwnedProjects(ctx, id)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		users, err := s.warm.ListUsers(ctx)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		would := map[string]any{"userId": id, "entries": 0, "tokens": 0, "ownedProjects": owned}
		for _, u := range users {
			if u.ID == id {
				would["email"] = u.Email
				would["entries"] = u.EntryCount
				would["tokens"] = u.TokenCount
			}
		}
		writeJSONValue(w, http.StatusOK, map[string]any{"dryRun": true, "wouldDelete": would})
		return
	}
	result, err := s.engine.DeleteUser(ctx, id)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.audit(r, "admin.user.delete", id, map[string]any{
		"entriesRemoved":  result.EntriesRemoved,
		"tokensRemoved":   result.TokensRemoved,
		"projectsDeleted": len(result.ProjectsDeleted),
		"coldCleanupOk":   result.ColdCleanupOK,
	})
	if !result.Deleted {
		reason := result.Reason
		if reason == "" {
			reason = "delete failed"
		}
		s.sendError(w, http.StatusConflict, reason)
		return
	}
	writeJSONValue(w, http.StatusOK, result)
}

func (s *server) handleAdminQuota(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	target, err := s.warm.FindUserByID(ctx, id)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if target == nil {
		s.sendError(w, http.StatusNotFound, "no such user")
		return
	}
	c, ok := s.meBody(w, r, true)
	if !ok {
		return
	}
	// Both fields are optional and nullable — absent or null clears the
	// override back to the server default.
	maxEntries := c.nullableInt("maxEntries")
	writesPerMinute := c.nullableInt("writesPerMinute")
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	if err := s.warm.SetUserQuota(ctx, id, maxEntries, writesPerMinute); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.audit(r, "admin.user.quota", id, map[string]any{
		"maxEntries": maxEntries, "writesPerMinute": writesPerMinute,
	})
	gotMax, gotWrites, err := s.warm.GetUserQuota(ctx, id)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{
		"userId": id,
		"quota":  map[string]any{"maxEntries": gotMax, "writesPerMinute": gotWrites},
	})
}

func (s *server) handleAdminAuditLog(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 || n > 500 {
			s.sendIssues(w, []issue{{Path: "limit", Message: "Invalid input", Code: "invalid_type"}})
			return
		}
		limit = n
	}
	entries, err := s.warm.ListAuditLog(r.Context(), limit)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"entries": entries})
}

// adminDashboardOff answers the 404 the metrics endpoints give when the
// dashboard switch is off. Checked BEFORE the role gate, so the answer is
// caller-independent (admin.ts ordering).
func (s *server) adminDashboardOff(w http.ResponseWriter) bool {
	if s.adminDashboard {
		return false
	}
	s.sendError(w, http.StatusNotFound, "admin disabled")
	return true
}

func (s *server) handleAdminMetrics(w http.ResponseWriter, r *http.Request) {
	if s.adminDashboardOff(w) || !s.requireAdmin(w, r) {
		return
	}
	writeJSONValue(w, http.StatusOK, orderedMetrics(s.metrics.Snapshot(r.Context())))
}

func (s *server) handleAdminMetricsProm(w http.ResponseWriter, r *http.Request) {
	if s.adminDashboardOff(w) || !s.requireAdmin(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	setHardeningHeaders(w)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(s.metrics.RenderProm(r.Context())))
}

func (s *server) handleAdminHealthDeep(w http.ResponseWriter, r *http.Request) {
	// adminAuth, not requireAdmin: a boolean gate that can't tell "no
	// credentials" from "wrong role", so both are 401.
	u := s.dashUser(r)
	if u == nil || u.Role != "admin" {
		s.sendError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	h := s.engine.Health(r.Context())
	status := http.StatusOK
	if ok, _ := h["ok"].(bool); !ok {
		status = http.StatusServiceUnavailable
	}
	orderedIn(h, "deps", "warm", "cold", "graph", "embedder")
	writeJSONValue(w, status, ordered(h, "ok", "deps", "pendingEmbeddings"))
}

// ─── Operator-gated maintenance ────────────────────────────────────────

func (s *server) handleDecay(w http.ResponseWriter, r *http.Request) {
	if !s.requireOperator(w, r) {
		return
	}
	c, ok := s.meBody(w, r, true)
	if !ok {
		return
	}
	effectiveDays, _ := c.number("effectiveDays", 0, 3650)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	result, err := s.engine.Decay(r.Context(), effectiveDays)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, result)
}

func (s *server) handleDreamCycle(w http.ResponseWriter, r *http.Request) {
	if !s.requireOperator(w, r) {
		return
	}
	result, err := s.engine.DreamCycle(r.Context())
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, result)
}

func (s *server) handleReapOrphans(w http.ResponseWriter, r *http.Request) {
	if !s.requireOperator(w, r) {
		return
	}
	result, err := s.engine.ReapOrphans(r.Context())
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, result)
}

// handleObserve triggers an observer + (conditional) reflector pass over
// recent memories. With NOVAMEM_OBSERVER_ENABLED off the engine returns
// nil and this answers 503 {"error":"observer disabled"} — the TS
// contract (routes/data-plane.ts /v1/observe).
func (s *server) handleObserve(w http.ResponseWriter, r *http.Request) {
	if !s.requireOperator(w, r) {
		return
	}
	c, ok := s.meBody(w, r, true)
	if !ok {
		return
	}
	// ObserveBody: {project?: string(≤128)|null, limit?: int 1..200}.
	// `project` is NOT resolved through the project-ref path here — TS
	// passes the raw body value straight to runObserver.
	projectRaw, projectSet := c.nullableStr("project", 0, 128)
	limit, limitSet := c.positiveInt("limit", 200)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	var project *string
	if projectSet {
		project = &projectRaw
	}
	if !limitSet {
		limit = 20 // body.limit ?? 20
	}
	result, err := s.engine.RunObserver(r.Context(), s.userID(r), project, limit)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if result == nil {
		s.sendError(w, http.StatusServiceUnavailable, "observer disabled")
		return
	}
	writeJSONValue(w, http.StatusOK, result)
}

func isTrue(v string) bool {
	switch strings.ToLower(v) {
	case "1", "true", "yes":
		return true
	}
	return false
}
