// Data-plane routes: /v1/{remember,capture,recent,forget,stats} and
// PUT /v1/memories/{id}. Transcribed from routes/data-plane.ts +
// routes/schemas.ts + routes/context.ts (checkProjectAccess,
// shapeContent). Status codes, JSON field names and message strings are
// contract.
package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"unicode"
	"unicode/utf16"

	"github.com/azrtydxb/novamem/go/internal/engine"
)

// readBody caps at the TS server's global 2MB body limit (http.ts
// bodyLimit).
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			// Fastify answers FST_ERR_CTP_BODY_TOO_LARGE with 413.
			writeJSONValue(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "request body is too large"})
			return nil, false
		}
		writeJSONValue(w, http.StatusBadRequest, map[string]any{"error": "could not read request body"})
		return nil, false
	}
	return body, true
}

func (s *server) sendError(w http.ResponseWriter, status int, msg string) {
	writeJSONValue(w, status, map[string]any{"error": msg})
}

func (s *server) sendIssues(w http.ResponseWriter, issues []issue) {
	writeJSONValue(w, http.StatusBadRequest, map[string]any{
		"error":  "invalid request body",
		"issues": issues,
	})
}

// sendEngineErr maps engine errors onto the http.ts error handler's
// shapes: client-safe 4xx → {error: msg}; everything else → 500
// {"error":"internal server error"} with the real error logged.
func (s *server) sendEngineErr(w http.ResponseWriter, r *http.Request, err error) {
	var he *engine.HTTPError
	if errors.As(err, &he) && he.StatusCode >= 400 && he.StatusCode < 500 {
		s.sendError(w, he.StatusCode, he.Message)
		return
	}
	s.log.Error("request failed", "method", r.Method, "url", r.URL.Path, "err", err)
	s.sendError(w, http.StatusInternalServerError, "internal server error")
}

// ─── Shared body pieces ────────────────────────────────────────────────

// parseWriteBody validates RememberBody / CaptureBody (identical field
// rules — schemas.ts).
func parseWriteBody(c *v) engine.RememberRequest {
	var req engine.RememberRequest
	req.Content, _ = c.str("content", true, 1, MaxContentBytes)
	req.Namespace, _ = c.str("namespace", false, 0, 128)
	req.Source, _ = c.str("source", false, 0, 128)
	if s, ok := c.nullableStr("agentName", 0, 128); ok {
		req.AgentName = &s
	}
	req.Project, _ = c.projectRef("project")
	req.Metadata, _ = c.metadata("metadata")
	req.Sensitivity, _ = c.enum("sensitivity", "public", "internal", "private", "sensitive")
	if s, ok := c.str("sourceType", false, 0, 64); ok {
		req.SourceType = &s
	}
	if s, ok := c.str("capturedFrom", false, 0, 256); ok {
		req.CapturedFrom = &s
	}
	if n, ok := c.number("confidence", 0, 1); ok {
		req.Confidence = &n
	}
	req.Force, _ = c.boolean("force")
	req.ExpiresAt, _ = c.datetime("expiresAt", "")
	return req
}

// ─── Project access (routes/context.ts checkProjectAccess) ─────────────

type projectScope struct {
	Project         *string
	IncludeProjects []string
}

// checkProjectAccess resolves project refs (id or name) to ULIDs,
// verifies membership, and applies active-project defaulting. Returns
// false when it already sent the response.
func (s *server) checkProjectAccess(w http.ResponseWriter, r *http.Request, userID string, body *projectScope, unionWithActive bool) bool {
	ctx := r.Context()
	if tok := callerOf(r).token; tok != nil && tok.ProjectID != nil {
		return s.confineToTokenProject(w, r, userID, *tok.ProjectID, body)
	}
	noScope := body.Project == nil && len(body.IncludeProjects) == 0
	if noScope {
		active, err := s.warm.GetActiveProject(ctx, userID)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return false
		}
		if active != "" {
			if unionWithActive {
				body.IncludeProjects = []string{active}
			} else {
				body.Project = &active
			}
		}
	}
	resolve := func(ref string) (string, bool) {
		if id, found, err := s.warm.GetProject(ctx, ref); err != nil {
			s.sendEngineErr(w, r, err)
			return "", false
		} else if found {
			return id, true
		}
		if id, found, err := s.warm.FindProjectByName(ctx, userID, ref); err != nil {
			s.sendEngineErr(w, r, err)
			return "", false
		} else if found {
			return id, true
		}
		s.sendError(w, http.StatusNotFound,
			"no such project '"+ref+"' — call project_list to see ids")
		return "", false
	}
	check := func(ref string) (string, bool) {
		id, ok := resolve(ref)
		if !ok {
			return "", false
		}
		member, err := s.warm.GetProjectMembership(ctx, id, userID)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return "", false
		}
		if !member {
			s.sendError(w, http.StatusForbidden,
				"not a member of project '"+ref+"' (id "+id+")")
			return "", false
		}
		return id, true
	}
	if body.Project != nil {
		id, ok := check(*body.Project)
		if !ok {
			return false
		}
		body.Project = &id
	}
	for i, ref := range body.IncludeProjects {
		id, ok := check(ref)
		if !ok {
			return false
		}
		body.IncludeProjects[i] = id
	}
	return true
}

// resolveProjectRef maps an id-or-name to a project id.
func (s *server) resolveProjectRef(ctx context.Context, userID, ref string) (string, bool, error) {
	if id, found, err := s.warm.GetProject(ctx, ref); err != nil || found {
		return id, found, err
	}
	return s.warm.FindProjectByName(ctx, userID, ref)
}

// confineToTokenProject forces every data-plane call carried by a
// project-confined bearer into that project. An explicit request for
// anything else is a 403 — not a silent rewrite, because a caller that
// asked for another scope and got this one would misattribute what it
// reads and writes. `body.project` alone is the engine's "this project
// only" read scope, so confinement also excludes the user-global store.
func (s *server) confineToTokenProject(w http.ResponseWriter, r *http.Request, userID, tokenProject string, body *projectScope) bool {
	ctx := r.Context()
	explicit := body.IncludeProjects
	if body.Project != nil {
		explicit = append([]string{*body.Project}, explicit...)
	}
	for _, ref := range explicit {
		id, found, err := s.resolveProjectRef(ctx, userID, ref)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return false
		}
		if !found || id != tokenProject {
			s.sendError(w, http.StatusForbidden, "token is confined to its project")
			return false
		}
	}
	body.Project = &tokenProject
	body.IncludeProjects = nil
	// A token whose user was since removed from the project must not pass.
	member, err := s.warm.GetProjectMembership(ctx, tokenProject, userID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return false
	}
	if !member {
		s.sendError(w, http.StatusForbidden, "not a member of the token's project")
		return false
	}
	return true
}

// ─── Content shaping (routes/context.ts shapeContent) ──────────────────

const snippetChars = 240

func shapeContent(results []engine.SearchResultItem, mode string) {
	if mode == "" || mode == "full" {
		return
	}
	for _, r := range results {
		content, _ := r["content"].(string)
		if mode == "ids" {
			delete(r, "content")
			delete(r, "metadata")
			continue
		}
		// snippet — operate in UTF-16 units to match JS slice/search.
		u := utf16.Encode([]rune(content))
		if len(u) <= snippetChars {
			continue
		}
		cut := u[:snippetChars]
		// cut.search(/\s\S*$/): index of the last whitespace character
		// (only whitespace followed exclusively by non-whitespace matches).
		boundary := -1
		for i, unit := range cut {
			if unit < 0xD800 && unicode.IsSpace(rune(unit)) {
				boundary = i
			}
		}
		if boundary > snippetChars/2 {
			cut = cut[:boundary]
		}
		r["content"] = string(utf16.Decode(cut)) + "…"
		r["truncated"] = true
	}
}

// ─── Routes ────────────────────────────────────────────────────────────

func (s *server) registerDataPlane(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/remember", s.withAuth(s.handleRemember))
	mux.HandleFunc("POST /v1/capture", s.withAuth(s.handleCapture))
	mux.HandleFunc("POST /v1/session-recap", s.withAuth(s.handleSessionRecap))
	mux.HandleFunc("POST /v1/recent", s.withAuth(s.handleRecent))
	mux.HandleFunc("POST /v1/forget", s.withAuth(s.handleForget))
	mux.HandleFunc("PUT /v1/memories/{id}", s.withAuth(s.handleUpdate))
	mux.HandleFunc("GET /v1/stats", s.withAuth(s.handleStats))
}

func (s *server) handleWrite(w http.ResponseWriter, r *http.Request, capture bool) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	m, decodeErr := decodeBody(body, false)
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return
	}
	c := &v{m: m}
	req := parseWriteBody(c)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	userID := s.userID(r)
	scope := projectScope{Project: req.Project}
	if !s.checkProjectAccess(w, r, userID, &scope, false) {
		return
	}
	req.Project = scope.Project

	var result engine.RememberResult
	var err error
	if capture {
		// Capture defaults (routes/data-plane.ts /v1/capture handler).
		if req.Source == "" {
			req.Source = "memory_capture"
		}
		if req.SourceType == nil {
			st := "chat"
			req.SourceType = &st
		}
		if req.CapturedFrom == nil {
			cf := "memory_capture"
			req.CapturedFrom = &cf
		}
		result, err = s.engine.Capture(r.Context(), userID, req)
	} else {
		result, err = s.engine.Remember(r.Context(), userID, req)
	}
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusCreated, result)
}

func (s *server) handleRemember(w http.ResponseWriter, r *http.Request) {
	s.handleWrite(w, r, false)
}

func (s *server) handleCapture(w http.ResponseWriter, r *http.Request) {
	s.handleWrite(w, r, true)
}

func (s *server) handleRecent(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	m, decodeErr := decodeBody(body, true) // RecentBody.optional()
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return
	}
	c := &v{m: m}
	var args engine.RecentArgs
	args.Namespace, _ = c.str("namespace", false, 0, 128)
	args.K, _ = c.positiveInt("k", 200)
	args.Since, _ = c.datetime("since", "since must be ISO-8601 (e.g. 2026-05-02T17:00:00Z)")
	args.Project, _ = c.projectRef("project")
	args.IncludeProjects, _ = c.strArray("includeProjects", 16,
		func(s string) bool { return utf16Len(s) >= 1 && utf16Len(s) <= 128 && projectRefRe.MatchString(s) },
		"project ref contains control characters")
	args.IncludeNamespaces, _ = c.strArray("includeNamespaces", 16, validNamespaceItem,
		"namespace must start alphanumeric and contain only letters, digits, dot, colon, underscore, or dash")
	args.MaxSensitivity, _ = c.enum("maxSensitivity", "public", "internal", "private", "sensitive")
	contentMode, _ := c.enum("contentMode", "full", "snippet", "ids")
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	userID := s.userID(r)
	scope := projectScope{Project: args.Project, IncludeProjects: args.IncludeProjects}
	if !s.checkProjectAccess(w, r, userID, &scope, true) {
		return
	}
	args.Project = scope.Project
	args.IncludeProjects = scope.IncludeProjects

	results, err := s.engine.Recent(r.Context(), userID, args)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	shapeContent(results, contentMode)
	writeJSONValue(w, http.StatusOK, map[string]any{"results": results})
}

func (s *server) handleForget(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	m, decodeErr := decodeBody(body, false)
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return
	}
	c := &v{m: m}
	id, _ := c.str("id", true, 1, 128)
	project, _ := c.projectRef("project")
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	userID := s.userID(r)
	scope := projectScope{Project: project}
	if !s.checkProjectAccess(w, r, userID, &scope, false) {
		return
	}
	// Defence in depth (routes/data-plane.ts /v1/forget): resolve the
	// entry's actual scope by id alone and re-verify, so knowing an id
	// is not enough to delete a row outside the caller's scope.
	scopeUser, scopeProject, found, err := s.warm.GetEntryScope(r.Context(), id)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if found {
		if scopeProject != nil {
			member, err := s.warm.GetProjectMembership(r.Context(), *scopeProject, userID)
			if err != nil {
				s.sendEngineErr(w, r, err)
				return
			}
			if !member {
				s.sendError(w, http.StatusForbidden, "not a member of this project")
				return
			}
		} else if scopeUser != userID {
			s.sendError(w, http.StatusForbidden, "entry not in your user namespace")
			return
		}
	}
	result, err := s.engine.Forget(r.Context(), userID, id, scope.Project)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, result)
}

func (s *server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || utf16Len(id) > 128 {
		s.sendIssues(w, []issue{{Path: "id", Message: "String must contain at most 128 character(s)", Code: "too_big"}})
		return
	}
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	m, decodeErr := decodeBody(body, false)
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return
	}
	c := &v{m: m}
	var req engine.UpdateRequest
	if s2, ok := c.str("content", false, 1, MaxContentBytes); ok {
		req.Content = &s2
	}
	if s2, ok := c.str("namespace", false, 0, 128); ok {
		req.Namespace = &s2
	}
	req.Metadata, _ = c.metadata("metadata")
	req.Sensitivity, _ = c.enum("sensitivity", "public", "internal", "private", "sensitive")
	if s2, ok := c.str("sourceType", false, 0, 64); ok {
		req.SourceType = &s2
	}
	if s2, ok := c.str("capturedFrom", false, 0, 256); ok {
		req.CapturedFrom = &s2
	}
	if n, ok := c.number("confidence", 0, 1); ok {
		req.Confidence = &n
	}
	req.Project, _ = c.projectRef("project")
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	userID := s.userID(r)
	scope := projectScope{Project: req.Project}
	if !s.checkProjectAccess(w, r, userID, &scope, false) {
		return
	}
	req.Project = scope.Project

	result, err := s.engine.Update(r.Context(), userID, id, req)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !result.Updated {
		s.sendError(w, http.StatusNotFound, "no such memory in your scope")
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{
		"id":               id,
		"updated":          result.Updated,
		"embeddingChanged": result.EmbeddingChanged,
	})
}

func (s *server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.engine.GetStats(r.Context(), s.userID(r))
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, stats)
}
