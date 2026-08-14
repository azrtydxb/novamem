// /v1/me/* — the user self-service surface. Transcribed from
// packages/server/src/routes/me.ts; the auth middleware has already
// resolved the dashboard user (session cookie OR a full-scope `nm_…`
// bearer) and 401'd otherwise, so every handler here can trust
// callerOf(r).dash.
package httpapi

import (
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/metrics"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

var tokenHashRe = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func (s *server) registerMe(mux *http.ServeMux) {
	get := func(path string, h http.HandlerFunc) { mux.HandleFunc("GET "+path, s.withAuth(h)) }
	mux.HandleFunc("GET /v1/me/metrics", s.withAuth(s.handleMeMetrics))
	get("/v1/me/metrics/history", s.handleMeMetricsHistory)
	get("/v1/me/tokens", s.handleMeTokensList)
	mux.HandleFunc("POST /v1/me/tokens", s.withAuth(s.handleMeTokenMint))
	mux.HandleFunc("DELETE /v1/me/tokens/{hash}", s.withAuth(s.handleMeTokenDelete))
	get("/v1/me/projects", s.handleMeProjectsList)
	mux.HandleFunc("POST /v1/me/projects", s.withAuth(s.handleMeProjectCreate))
	mux.HandleFunc("DELETE /v1/me/projects/{id}", s.withAuth(s.handleMeProjectDelete))
	get("/v1/me/projects/{id}/members", s.handleMeMembersList)
	mux.HandleFunc("POST /v1/me/projects/{id}/members", s.withAuth(s.handleMeMemberAdd))
	mux.HandleFunc("DELETE /v1/me/projects/{id}/members/{userId}", s.withAuth(s.handleMeMemberRemove))
	get("/v1/me/active-project", s.handleMeActiveGet)
	mux.HandleFunc("PUT /v1/me/active-project", s.withAuth(s.handleMeActiveSet))
	mux.HandleFunc("DELETE /v1/me/active-project", s.withAuth(s.handleMeActiveClear))
	get("/v1/me/export", s.handleMeExport)
	mux.HandleFunc("POST /v1/me/import", s.withAuth(s.handleMeImport))
	get("/v1/me/usage", s.handleMeUsage)
	get("/v1/me/changes", s.handleMeChanges)
	get("/v1/me/today", s.handleMeToday)
	get("/v1/me/onboarding", s.handleMeOnboarding)
}

func (s *server) dashUser(r *http.Request) *warmstore.User { return callerOf(r).dash }

// audit records an operator-visible action. Failures are logged, never
// surfaced — an audit gap beats failing the action it describes.
func (s *server) audit(r *http.Request, action, target string, metadata map[string]any) {
	label := "unknown"
	var actorID *string
	if u := s.dashUser(r); u != nil {
		label = "user:" + u.Username
		actorID = &u.ID
	}
	if err := s.warm.WriteAudit(r.Context(), actorID, label, action, &target, metadata, clientIP(r)); err != nil {
		s.log.Warn("audit write failed", "action", action, "err", err)
	}
}

// meBody decodes+validates a JSON body, replying 400 on issues.
func (s *server) meBody(w http.ResponseWriter, r *http.Request, optional bool) (*v, bool) {
	body, ok := readBody(w, r)
	if !ok {
		return nil, false
	}
	m, decodeErr := decodeBody(body, optional)
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return nil, false
	}
	return &v{m: m}, true
}

// ─── Metrics ───────────────────────────────────────────────────────────

func (s *server) handleMeMetrics(w http.ResponseWriter, r *http.Request) {
	u := s.dashUser(r)
	rows, err := s.warm.ListUserTokens(r.Context(), u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	tokens := []metrics.TokenMetrics{}
	for _, t := range rows {
		if t.Revoked {
			continue
		}
		tokens = append(tokens, metrics.TokenMetrics{TokenHash: t.TokenHash, Label: t.Label})
	}
	ctx := r.Context()
	snap := s.metrics.SnapshotForUser(u.ID, tokens,
		s.metrics.UserWarmEntries(ctx, u.ID), s.metrics.UserColdEntries(ctx, u.ID))
	// me.ts: an admin reading their own metrics gets the *global*
	// snapshot (that is what the dashboard's Metrics page renders —
	// pending_embeddings, orphans_pending, graph_edges …), with the
	// per-token rows kept and `_hasMyTokens` telling the SPA whether to
	// offer the per-token breakdown.
	if u.Role == "admin" {
		global := s.metrics.Snapshot(ctx)
		global["tokens"] = snap["tokens"]
		global["_hasMyTokens"] = len(tokens) > 0
		writeJSONValue(w, http.StatusOK, global)
		return
	}
	writeJSONValue(w, http.StatusOK, snap)
}

func (s *server) handleMeMetricsHistory(w http.ResponseWriter, r *http.Request) {
	hours := 24
	if raw := r.URL.Query().Get("hours"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 48 {
			s.sendIssues(w, []issue{{Path: "hours", Message: "invalid", Code: "invalid_type"}})
			return
		}
		hours = n
	}
	samples, err := s.warm.GetMetricsHistory(r.Context(), s.dashUser(r).ID,
		time.Now().Add(-time.Duration(hours)*time.Hour))
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"hours": hours, "samples": samples})
}

// ─── Tokens ────────────────────────────────────────────────────────────

func (s *server) handleMeTokensList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.warm.ListUserTokens(r.Context(), s.dashUser(r).ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"tokens": rows})
}

func (s *server) handleMeTokenMint(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := s.dashUser(r)
	c, ok := s.meBody(w, r, true)
	if !ok {
		return
	}
	label, hasLabel := c.str("label", false, 0, 128)
	scope, _ := c.enum("scope", "full", "read_only")
	projectRef, _ := c.projectRef("project")
	expiresInDays, _ := c.positiveInt("expiresInDays", 3650)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	// A restricted bearer can't reach this route (the auth gate 403s
	// token mutations for it), so the caller is a full-scope credential
	// and may mint any narrowing of itself.
	var projectID *string
	if projectRef != nil {
		id, found, err := s.resolveProjectRef(ctx, u.ID, *projectRef)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		if !found {
			s.sendError(w, http.StatusNotFound,
				"no such project '"+*projectRef+"' — call project_list to see ids")
			return
		}
		member, err := s.warm.GetProjectMembership(ctx, id, u.ID)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		if !member {
			s.sendError(w, http.StatusForbidden, "not a member of project '"+*projectRef+"'")
			return
		}
		projectID = &id
	}
	var expiresAt *time.Time
	if expiresInDays > 0 {
		t := time.Now().Add(time.Duration(expiresInDays) * 24 * time.Hour)
		expiresAt = &t
	}
	if scope == "" {
		scope = "full"
	}
	var labelPtr *string
	if hasLabel {
		labelPtr = &label
	}
	token, createdAt, err := s.warm.CreateUserToken(ctx, u.ID, labelPtr, scope, projectID, expiresAt)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if token == "" {
		s.sendError(w, http.StatusNotFound, "user missing")
		return
	}
	var expiresISO *string
	if expiresAt != nil {
		iso := jsTime(*expiresAt)
		expiresISO = &iso
	}
	writeJSONValue(w, http.StatusCreated, map[string]any{
		"token":     token,
		"userId":    u.ID,
		"createdAt": jsTime(createdAt),
		"scope":     scope,
		"projectId": projectID,
		"expiresAt": expiresISO,
		"warning":   "Store this token now — it will not be shown again. Server retains only a sha256 hash.",
	})
}

func (s *server) handleMeTokenDelete(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	if !tokenHashRe.MatchString(hash) {
		s.sendIssues(w, []issue{{Path: "hash", Message: "Invalid", Code: "invalid_string"}})
		return
	}
	deleted, err := s.warm.DeleteUserTokenByHash(r.Context(), s.dashUser(r).ID, hash)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !deleted {
		s.sendError(w, http.StatusNotFound, "token not found")
		return
	}
	s.metrics.ForgetToken(hash)
	writeJSONValue(w, http.StatusOK, map[string]any{"deleted": true})
}

// ─── Projects ──────────────────────────────────────────────────────────

func (s *server) handleMeProjectsList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.warm.ListProjectsForUser(r.Context(), s.dashUser(r).ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, p := range rows {
		out = append(out, map[string]any{
			"id": p.ID, "name": p.Name, "role": p.Role,
			"ownerUserId": p.OwnerUserID, "createdAt": jsTime(p.CreatedAt),
		})
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"projects": out})
}

func (s *server) handleMeProjectCreate(w http.ResponseWriter, r *http.Request) {
	u := s.dashUser(r)
	c, ok := s.meBody(w, r, false)
	if !ok {
		return
	}
	name, _ := c.str("name", true, 1, 128)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	p, err := s.warm.CreateProject(r.Context(), engine.NewULID(), name, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.audit(r, "project.create", p.ID, map[string]any{"name": name})
	writeJSONValue(w, http.StatusCreated, map[string]any{
		"id": p.ID, "name": p.Name, "ownerUserId": p.OwnerUserID, "createdAt": jsTime(p.CreatedAt),
	})
}

// meProject resolves the {id} path segment (id or name) to a project the
// caller can see, replying 404 "unknown project" otherwise.
func (s *server) meProject(w http.ResponseWriter, r *http.Request) (*warmstore.Project, bool) {
	ref := r.PathValue("id")
	id, found, err := s.resolveProjectRef(r.Context(), s.dashUser(r).ID, ref)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return nil, false
	}
	if found {
		info, err := s.warm.GetProjectInfo(r.Context(), id)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return nil, false
		}
		if info != nil {
			return info, true
		}
	}
	s.sendError(w, http.StatusNotFound, "unknown project")
	return nil, false
}

func (s *server) handleMeProjectDelete(w http.ResponseWriter, r *http.Request) {
	u := s.dashUser(r)
	p, ok := s.meProject(w, r)
	if !ok {
		return
	}
	if p.OwnerUserID != u.ID {
		s.sendError(w, http.StatusForbidden, "only the owner can delete a project")
		return
	}
	res, err := s.engine.DeleteProject(r.Context(), p.ID, p.OwnerUserID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.audit(r, "project.delete", p.ID, map[string]any{"entriesRemoved": res.EntriesRemoved})
	writeJSONValue(w, http.StatusOK, res)
}

func (s *server) handleMeMembersList(w http.ResponseWriter, r *http.Request) {
	u := s.dashUser(r)
	p, ok := s.meProject(w, r)
	if !ok {
		return
	}
	member, err := s.warm.GetProjectMembership(r.Context(), p.ID, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !member {
		s.sendError(w, http.StatusForbidden, "not a member of this project")
		return
	}
	members, err := s.warm.ListProjectMembers(r.Context(), p.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"members": members})
}

func (s *server) handleMeMemberAdd(w http.ResponseWriter, r *http.Request) {
	u := s.dashUser(r)
	p, ok := s.meProject(w, r)
	if !ok {
		return
	}
	if p.OwnerUserID != u.ID {
		s.sendError(w, http.StatusForbidden, "only the owner can add members")
		return
	}
	c, ok := s.meBody(w, r, false)
	if !ok {
		return
	}
	username, _ := c.str("username", true, 1, 64)
	role, _ := c.enum("role", "owner", "member")
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	if role == "" {
		role = "member"
	}
	// Exact email only — `name`-based fuzzy matching here would let a
	// newly-registered attacker collide with a target's display name and
	// be invited in their place.
	target, err := s.warm.FindUserByExactEmail(r.Context(), username)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if target == nil {
		s.sendError(w, http.StatusNotFound, "unknown user")
		return
	}
	added, err := s.warm.AddProjectMember(r.Context(), p.ID, target.ID, role)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !added {
		s.sendError(w, http.StatusConflict, "user is already a member")
		return
	}
	s.audit(r, "project.member.add", p.ID, map[string]any{
		"memberUserId": target.ID, "memberUsername": target.Username, "role": role,
	})
	writeJSONValue(w, http.StatusCreated, map[string]any{
		"added": true, "userId": target.ID, "username": target.Username,
	})
}

func (s *server) handleMeMemberRemove(w http.ResponseWriter, r *http.Request) {
	u := s.dashUser(r)
	p, ok := s.meProject(w, r)
	if !ok {
		return
	}
	userID := r.PathValue("userId")
	if p.OwnerUserID != u.ID && userID != u.ID {
		s.sendError(w, http.StatusForbidden, "only the owner can remove other members")
		return
	}
	if userID == p.OwnerUserID {
		s.sendError(w, http.StatusBadRequest, "owner cannot leave; delete the project instead")
		return
	}
	removed, err := s.warm.RemoveProjectMember(r.Context(), p.ID, userID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !removed {
		s.sendError(w, http.StatusNotFound, "user is not a member")
		return
	}
	s.audit(r, "project.member.remove", p.ID, map[string]any{"memberUserId": userID})
	writeJSONValue(w, http.StatusOK, map[string]any{"removed": true})
}

// ─── Active project ────────────────────────────────────────────────────

func (s *server) handleMeActiveGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := s.dashUser(r)
	projectID, err := s.warm.GetActiveProject(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	clear := func() {
		if err := s.warm.SetActiveProject(ctx, u.ID, nil); err != nil {
			s.log.Warn("clearing stale active project failed", "err", err)
		}
		writeJSONValue(w, http.StatusOK, map[string]any{"active": nil})
	}
	if projectID == "" {
		writeJSONValue(w, http.StatusOK, map[string]any{"active": nil})
		return
	}
	p, err := s.warm.GetProjectInfo(ctx, projectID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if p == nil {
		clear()
		return
	}
	member, err := s.warm.GetProjectMembership(ctx, projectID, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !member {
		clear()
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{
		"active": map[string]any{"id": p.ID, "name": p.Name},
	})
}

func (s *server) handleMeActiveSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := s.dashUser(r)
	c, ok := s.meBody(w, r, false)
	if !ok {
		return
	}
	ref, _ := c.projectRef("project")
	if ref == nil {
		c.add("project", "Required", "invalid_type")
	}
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	id, found, err := s.resolveProjectRef(ctx, u.ID, *ref)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !found {
		s.sendError(w, http.StatusNotFound, "no such project '"+*ref+"'")
		return
	}
	member, err := s.warm.GetProjectMembership(ctx, id, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !member {
		s.sendError(w, http.StatusForbidden, "not a member of this project")
		return
	}
	if err := s.warm.SetActiveProject(ctx, u.ID, &id); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"active": map[string]any{"id": id}})
}

func (s *server) handleMeActiveClear(w http.ResponseWriter, r *http.Request) {
	if err := s.warm.SetActiveProject(r.Context(), s.dashUser(r).ID, nil); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	setHardeningHeaders(w)
	w.WriteHeader(http.StatusNoContent)
}

// ─── Export / import / usage / changes ─────────────────────────────────

func (s *server) handleMeExport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 0
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 1000 {
			s.sendIssues(w, []issue{{Path: "limit", Message: "invalid", Code: "invalid_type"}})
			return
		}
		limit = n
	}
	afterID := q.Get("afterId")
	if len(afterID) > 64 {
		s.sendIssues(w, []issue{{Path: "afterId", Message: "Too big", Code: "too_big"}})
		return
	}
	entries, err := s.warm.ExportEntries(r.Context(), s.dashUser(r).ID, afterID, limit)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		metadata := e.Metadata
		if metadata == nil {
			metadata = map[string]any{}
		}
		out = append(out, map[string]any{
			"id": e.ID, "projectId": e.ProjectID, "content": e.Content,
			"namespace": e.Namespace, "source": e.Source, "agentName": e.AgentName,
			"metadata": metadata, "sourceType": e.SourceType, "capturedFrom": e.CapturedFrom,
			"confidence": e.Confidence,
			"createdAt":  jsTime(e.CreatedAt), "updatedAt": jsTime(e.UpdatedAt),
		})
	}
	var next *string
	if len(entries) > 0 {
		id := entries[len(entries)-1].ID
		next = &id
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"entries": out, "nextAfterId": next})
}

func (s *server) handleMeImport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := s.dashUser(r)
	c, ok := s.meBody(w, r, false)
	if !ok {
		return
	}
	rawEntries, _ := c.m["entries"].([]any)
	if len(rawEntries) == 0 || len(rawEntries) > 200 {
		s.sendIssues(w, []issue{{Path: "entries", Message: "invalid", Code: "invalid_type"}})
		return
	}
	reqs := make([]engine.RememberRequest, 0, len(rawEntries))
	for i, raw := range rawEntries {
		m, isObj := raw.(map[string]any)
		if !isObj {
			s.sendIssues(w, []issue{{
				Path: "entries." + strconv.Itoa(i), Message: "Expected object", Code: "invalid_type",
			}})
			return
		}
		ec := &v{m: m}
		content, _ := ec.str("content", true, 1, MaxContentBytes)
		namespace, _ := ec.str("namespace", false, 0, 128)
		source, _ := ec.str("source", false, 0, 128)
		agentName, hasAgent := ec.nullableStr("agentName", 0, 128)
		project, _ := ec.projectRef("project")
		metadata, _ := ec.metadata("metadata")
		sourceType, hasSourceType := ec.str("sourceType", false, 0, 64)
		capturedFrom, hasCapturedFrom := ec.str("capturedFrom", false, 0, 256)
		confidence, hasConfidence := ec.number("confidence", 0, 1)
		if len(ec.issues) > 0 {
			for j := range ec.issues {
				ec.issues[j].Path = "entries." + strconv.Itoa(i) + "." + ec.issues[j].Path
			}
			s.sendIssues(w, ec.issues)
			return
		}
		req := engine.RememberRequest{
			Content:   content,
			Namespace: namespace,
			// Ids are NOT preserved: they are deployment-local ULIDs and a
			// collision would graft foreign history onto a local row.
			// Content-hash dedup makes re-importing an export idempotent.
			Source:   source,
			Metadata: metadata,
			Project:  project,
			Force:    true,
		}
		if req.Source == "" {
			req.Source = "import"
		}
		if hasAgent {
			req.AgentName = &agentName
		}
		st := "import"
		if hasSourceType {
			st = sourceType
		}
		req.SourceType = &st
		cf := "import"
		if hasCapturedFrom {
			cf = capturedFrom
		}
		req.CapturedFrom = &cf
		if hasConfidence {
			req.Confidence = &confidence
		}
		reqs = append(reqs, req)
	}
	imported, deduplicated := 0, 0
	failed := []map[string]any{}
	for i, req := range reqs {
		// Project references from a foreign deployment don't resolve here;
		// import lands user-wide unless the caller pre-created the project.
		if req.Project != nil {
			id, found, err := s.resolveProjectRef(ctx, u.ID, *req.Project)
			if err != nil {
				s.sendEngineErr(w, r, err)
				return
			}
			if !found {
				failed = append(failed, map[string]any{
					"index": i,
					"error": "no such project '" + *req.Project + "' — call project_list to see ids",
				})
				continue
			}
			req.Project = &id
		}
		res, err := s.engine.Remember(ctx, u.ID, req)
		if err != nil {
			failed = append(failed, map[string]any{"index": i, "error": err.Error()})
			continue
		}
		if res.Deduplicated {
			deduplicated++
		} else if res.ID != nil {
			imported++
		}
	}
	s.audit(r, "user.import", u.ID, map[string]any{
		"imported": imported, "deduplicated": deduplicated, "failed": len(failed),
	})
	status := http.StatusCreated
	if len(failed) == len(reqs) {
		status = http.StatusBadRequest
	}
	writeJSONValue(w, status, map[string]any{
		"imported": imported, "deduplicated": deduplicated, "failed": failed,
	})
}

func (s *server) handleMeUsage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := s.dashUser(r)
	entries, err := s.warm.CountEntriesForUser(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	maxEntries, writesPerMinute, err := s.warm.GetUserQuota(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{
		"entries": entries,
		"quota":   map[string]any{"maxEntries": maxEntries, "writesPerMinute": writesPerMinute},
	})
}

func (s *server) handleMeChanges(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var since *time.Time
	if raw := q.Get("since"); raw != "" {
		if !isoDatetimeRe.MatchString(raw) {
			s.sendIssues(w, []issue{{Path: "since", Message: "Invalid datetime", Code: "invalid_string"}})
			return
		}
		t, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			s.sendIssues(w, []issue{{Path: "since", Message: "Invalid datetime", Code: "invalid_string"}})
			return
		}
		since = &t
	}
	var afterSeq *int64
	if raw := q.Get("afterSeq"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			s.sendIssues(w, []issue{{Path: "afterSeq", Message: "invalid", Code: "invalid_type"}})
			return
		}
		afterSeq = &n
	}
	limit := 0
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 500 {
			s.sendIssues(w, []issue{{Path: "limit", Message: "invalid", Code: "invalid_type"}})
			return
		}
		limit = n
	}
	changes, err := s.warm.ListChanges(r.Context(), s.dashUser(r).ID, since, afterSeq, limit)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(changes))
	for _, c := range changes {
		out = append(out, map[string]any{
			"seq": c.Seq, "entryId": c.EntryID, "projectId": c.ProjectID,
			"change": c.Change, "detail": c.Detail, "at": jsTime(c.At),
		})
	}
	// nextSeq is the resume cursor: pass it back as afterSeq to page
	// forward without missing same-timestamp rows.
	var nextSeq any
	if len(changes) > 0 {
		nextSeq = changes[len(changes)-1].Seq
	} else if afterSeq != nil {
		nextSeq = *afterSeq
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"changes": out, "nextSeq": nextSeq})
}

func (s *server) handleMeToday(w http.ResponseWriter, r *http.Request) {
	events, err := s.warm.ListRecentActivity(r.Context(), s.dashUser(r).ID, 50)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"events": events})
}

func (s *server) handleMeOnboarding(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := s.dashUser(r)
	tokens, err := s.warm.CountLiveTokens(ctx, u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	recent, err := s.engine.Recent(ctx, u.ID, engine.RecentArgs{K: 1})
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{
		"bootstrapDone": true,
		"userExists":    true,
		"mintedToken":   tokens > 0,
		"remembered":    len(recent) > 0,
		"userId":        u.ID,
	})
}
