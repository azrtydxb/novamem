// MCP tool dispatch — the CallTool switch transcribed from
// packages/server/src/mcp.ts, validating arguments with the same rules
// as the HTTP bodies (mcp-tools.ts reuses the zod body schemas) and
// calling the same engine methods. Transport/session/wire concerns live
// in internal/mcp; this file only maps tool names onto the engine.
//
// Error contract (mcp.ts): every failure is returned as an error whose
// message becomes `error: <msg>` isError content — never a protocol
// crash. Validation failures mirror parseToolArgs:
// "invalid argument '<path>': <zod message>".
package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/mcp"
)

func (s *server) registerMCP(mux *http.ServeMux) *mcp.Server {
	srv := mcp.NewServer(mcp.Options{
		Log:            s.log,
		Instructions:   novamemInstructions,
		AllowedOrigins: s.corsOrigins,
		Call:           s.callTool,
	})
	streamable := s.withAuth(func(w http.ResponseWriter, r *http.Request) {
		srv.ServeStreamable(w, r, s.userID(r))
	})
	mux.HandleFunc("POST /mcp", streamable)
	mux.HandleFunc("GET /mcp", streamable)
	mux.HandleFunc("DELETE /mcp", streamable)
	mux.HandleFunc("GET /mcp/sse", s.withAuth(func(w http.ResponseWriter, r *http.Request) {
		srv.ServeSSE(w, r, s.userID(r))
	}))
	mux.HandleFunc("POST /mcp/messages", s.withAuth(func(w http.ResponseWriter, r *http.Request) {
		srv.ServeMessages(w, r, s.userID(r))
	}))
	return srv
}

// firstIssue converts accumulated validation issues into the
// parseToolArgs error shape (first issue only, like TS).
func firstIssue(c *v) error {
	if len(c.issues) == 0 {
		return nil
	}
	i := c.issues[0]
	if i.Path == "" {
		return fmt.Errorf("%s", i.Message)
	}
	return fmt.Errorf("invalid argument '%s': %s", i.Path, i.Message)
}

// resolveScopeMCP — mcp-tools.ts resolveScope: canonicalize project +
// includeProjects refs (id or name) with membership checks, falling
// back to the caller's active project when no scope was supplied.
// unionWithActive=true (reads) puts the active project in
// includeProjects so reads union with user-global; false (writes)
// targets the active project directly.
func (s *server) resolveScopeMCP(ctx context.Context, userID string, project *string, includeProjects []string, unionWithActive bool) (*string, []string, error) {
	if project == nil && len(includeProjects) == 0 {
		active, err := s.warm.GetActiveProject(ctx, userID)
		if err != nil {
			return nil, nil, err
		}
		if active != "" {
			if unionWithActive {
				includeProjects = []string{active}
			} else {
				project = &active
			}
		}
	}
	resolveOne := func(ref string) (string, error) {
		id, found, err := s.warm.GetProject(ctx, ref)
		if err != nil {
			return "", err
		}
		if !found {
			id, found, err = s.warm.FindProjectByName(ctx, userID, ref)
			if err != nil {
				return "", err
			}
		}
		if !found {
			return "", fmt.Errorf("no such project '%s' — call project_list to see ids", ref)
		}
		member, err := s.warm.GetProjectMembership(ctx, id, userID)
		if err != nil {
			return "", err
		}
		if !member {
			return "", fmt.Errorf("not a member of project '%s' (id %s)", ref, id)
		}
		return id, nil
	}
	if project != nil {
		id, err := resolveOne(*project)
		if err != nil {
			return nil, nil, err
		}
		project = &id
	}
	for i, ref := range includeProjects {
		id, err := resolveOne(ref)
		if err != nil {
			return nil, nil, err
		}
		includeProjects[i] = id
	}
	return project, includeProjects, nil
}

// jsTime renders like JS Date JSON serialization (ms precision, Z).
func jsTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// searchBody / recentBody hold the validated argument subsets the MCP
// data-plane tools pass to the engine (mcp.ts passes exactly these).

func (s *server) callTool(ctx context.Context, userID, name string, args map[string]any) (any, error) {
	c := &v{m: args}
	switch name {

	case "memory_context":
		message, _ := c.str("message", true, 1, 8*1024)
		k, kSet := c.positiveInt("k", 50)
		namespace, _ := c.str("namespace", false, 0, 128)
		includeNamespaces, _ := c.strArray("includeNamespaces", 16, validNamespaceItem,
			"namespace must start alphanumeric and contain only letters, digits, dot, colon, underscore, or dash")
		project, _ := c.projectRef("project")
		includeProjects, _ := c.strArray("includeProjects", 16, validProjectRefItem, "project ref contains control characters")
		weights := c.parseWeights()
		maxSensitivity, _ := c.enum("maxSensitivity", "public", "internal", "private", "sensitive")
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, includeProjects, err := s.resolveScopeMCP(ctx, userID, project, includeProjects, true)
		if err != nil {
			return nil, err
		}
		if !kSet {
			k = 8
		}
		relevant, err := s.engine.Search(ctx, userID, engine.SearchArgs{
			Query: message, K: k, Namespace: namespace, IncludeNamespaces: includeNamespaces,
			Project: project, IncludeProjects: includeProjects, Weights: weights, MaxSensitivity: maxSensitivity,
		})
		if err != nil {
			return nil, err
		}
		recentK := k
		if recentK > 10 {
			recentK = 10
		}
		recent, err := s.engine.Recent(ctx, userID, engine.RecentArgs{
			K: recentK, Namespace: namespace, IncludeNamespaces: includeNamespaces,
			Project: project, IncludeProjects: includeProjects, MaxSensitivity: maxSensitivity,
		})
		if err != nil {
			return nil, err
		}
		if relevant.Results == nil {
			relevant.Results = []engine.SearchResultItem{}
		}
		return map[string]any{
			"relevant":    map[string]any{"results": relevant.Results, "degraded": relevant.Degraded},
			"recent":      map[string]any{"results": recent},
			"contextPack": engine.BuildContextPack(relevant.Results, recent),
			"guidance":    "Use this context before answering. Prefer contextPack sections over loose hits. If relevant is empty, run targeted memory_search before asking the user to repeat context.",
		}, nil

	case "memory_capture":
		req := parseWriteBody(c)
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, _, err := s.resolveScopeMCP(ctx, userID, req.Project, nil, false)
		if err != nil {
			return nil, err
		}
		req.Project = project
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
		r, err := s.engine.Capture(ctx, userID, req)
		if err != nil {
			return nil, err
		}
		saved := 0
		if r.ID != nil {
			saved = 1
		}
		return map[string]any{"saved": saved, "results": []engine.RememberResult{r}}, nil

	case "memory_session_recap":
		// SessionRecapBody is .strict() — unknown keys are rejected.
		for key := range args {
			if !recapKnownKeys[key] {
				c.add("", fmt.Sprintf("Unrecognized key(s) in object: '%s'", key), "unrecognized_keys")
			}
		}
		items := map[string][]string{}
		for _, g := range recapGroups {
			if arr, ok := c.strArray(g.field, 1<<30,
				func(s string) bool { return utf16Len(s) >= 12 && utf16Len(s) <= 4000 },
				"String must contain at least 12 character(s)"); ok {
				items[g.field] = arr
			}
		}
		namespace, _ := c.str("namespace", false, 1, 128)
		source, _ := c.str("source", false, 1, 256)
		sourceType, _ := c.str("sourceType", false, 1, 64)
		capturedFrom, _ := c.str("capturedFrom", false, 1, 256)
		var agentName *string
		if a, ok := c.nullableStr("agentName", 0, 128); ok {
			agentName = &a
		}
		var confidence *float64
		if n, ok := c.number("confidence", 0, 1); ok {
			confidence = &n
		}
		force, _ := c.boolean("force")
		project, _ := c.projectRef("project")
		var metadata map[string]any
		if raw, present := args["metadata"]; present && raw != nil {
			if mm, ok := raw.(map[string]any); ok {
				metadata = mm
			} else {
				c.add("metadata", fmt.Sprintf("Expected object, received %s", jsonType(raw)), "invalid_type")
			}
		}
		sensitivity, _ := c.enum("sensitivity", "public", "internal", "private", "sensitive")
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, _, err := s.resolveScopeMCP(ctx, userID, project, nil, false)
		if err != nil {
			return nil, err
		}
		if source == "" {
			source = "memory_session_recap"
		}
		if sourceType == "" {
			sourceType = "summary"
		}
		if capturedFrom == "" {
			capturedFrom = "memory_session_recap"
		}
		results := []engine.RememberResult{}
		saved := 0
		for _, g := range recapGroups {
			groupNamespace := namespace
			if groupNamespace == "" {
				groupNamespace = g.namespace
				if g.field == "other" {
					groupNamespace = "memory"
				}
			}
			for _, content := range items[g.field] {
				md := map[string]any{}
				for k, val := range metadata {
					md[k] = val
				}
				md["memoryType"] = g.memoryType
				md["recap"] = true
				r, err := s.engine.Capture(ctx, userID, engine.RememberRequest{
					Content: content, Namespace: groupNamespace, Source: source,
					AgentName: agentName, Project: project, Metadata: md,
					SourceType: &sourceType, CapturedFrom: &capturedFrom,
					Confidence: confidence, Force: force, Sensitivity: sensitivity,
				})
				if err != nil {
					return nil, err
				}
				if r.ID != nil {
					saved++
				}
				results = append(results, r)
			}
		}
		return map[string]any{"saved": saved, "results": results}, nil

	case "memory_hygiene":
		checkStrict(c, "k")
		k := 0
		if n, ok := c.number("k", 0, 1e9); ok {
			k = int(n)
		}
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		return s.engine.HygieneReport(ctx, userID, k)

	case "memory_evaluate":
		checkStrict(c, "suite")
		suite, _ := c.str("suite", false, 1, 64)
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		return s.engine.EvaluateMemoryQuality(ctx, userID, suite)

	case "memory_adoption":
		checkStrict(c, "client", "observedTools", "observedInstructionsHash")
		var opts adoptionOptions
		opts.Client, _ = c.str("client", false, 0, 64)
		if tools, ok := c.strArray("observedTools", 128,
			func(s string) bool { return utf16Len(s) >= 1 && utf16Len(s) <= 128 }, "Invalid"); ok {
			opts.ObservedTools = tools
			opts.ObservedToolsSet = true
		}
		if hash, ok := c.str("observedInstructionsHash", false, 0, 1<<30); ok {
			if instructionsHashRe.MatchString(hash) {
				opts.ObservedInstructionsHash = &hash
			} else {
				c.add("observedInstructionsHash", "Invalid", "invalid_string")
			}
		}
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		return buildAdoptionReport(opts), nil

	case "memory_search":
		query, _ := c.str("query", true, 1, 8*1024)
		k, _ := c.positiveInt("k", 200)
		namespace, _ := c.str("namespace", false, 0, 128)
		includeNamespaces, _ := c.strArray("includeNamespaces", 16, validNamespaceItem,
			"namespace must start alphanumeric and contain only letters, digits, dot, colon, underscore, or dash")
		project, _ := c.projectRef("project")
		includeProjects, _ := c.strArray("includeProjects", 16, validProjectRefItem, "project ref contains control characters")
		weights := c.parseWeights()
		maxSensitivity, _ := c.enum("maxSensitivity", "public", "internal", "private", "sensitive")
		contentMode, _ := c.enum("contentMode", "full", "snippet", "ids")
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, includeProjects, err := s.resolveScopeMCP(ctx, userID, project, includeProjects, true)
		if err != nil {
			return nil, err
		}
		outcome, err := s.engine.Search(ctx, userID, engine.SearchArgs{
			Query: query, K: k, Namespace: namespace, IncludeNamespaces: includeNamespaces,
			Project: project, IncludeProjects: includeProjects, Weights: weights, MaxSensitivity: maxSensitivity,
		})
		if err != nil {
			return nil, err
		}
		if outcome.Results == nil {
			outcome.Results = []engine.SearchResultItem{}
		}
		shapeContent(outcome.Results, contentMode)
		return map[string]any{"results": outcome.Results, "degraded": outcome.Degraded}, nil

	case "memory_remember":
		req := parseWriteBody(c)
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, _, err := s.resolveScopeMCP(ctx, userID, req.Project, nil, false)
		if err != nil {
			return nil, err
		}
		// mcp.ts memory_remember passes no metadata / agentName — the MCP
		// remember surface is deliberately narrower than /v1/remember.
		req.Project = project
		req.Metadata = nil
		req.AgentName = nil
		r, err := s.engine.Remember(ctx, userID, req)
		if err != nil {
			return nil, err
		}
		return r, nil

	case "memory_today", "memory_recent":
		namespace, _ := c.str("namespace", false, 0, 128)
		includeNamespaces, _ := c.strArray("includeNamespaces", 16, validNamespaceItem,
			"namespace must start alphanumeric and contain only letters, digits, dot, colon, underscore, or dash")
		k, kSet := c.positiveInt("k", 200)
		since, _ := c.datetime("since", "since must be ISO-8601 (e.g. 2026-05-02T17:00:00Z)")
		project, _ := c.projectRef("project")
		includeProjects, _ := c.strArray("includeProjects", 16, validProjectRefItem, "project ref contains control characters")
		maxSensitivity, _ := c.enum("maxSensitivity", "public", "internal", "private", "sensitive")
		contentMode, _ := c.enum("contentMode", "full", "snippet", "ids")
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, includeProjects, err := s.resolveScopeMCP(ctx, userID, project, includeProjects, true)
		if err != nil {
			return nil, err
		}
		if name == "memory_today" {
			since = time.Now().UTC().Add(-24 * time.Hour).Format("2006-01-02T15:04:05.000Z")
			if !kSet {
				k = 20
			}
		}
		results, err := s.engine.Recent(ctx, userID, engine.RecentArgs{
			Namespace: namespace, IncludeNamespaces: includeNamespaces, K: k, Since: since,
			Project: project, IncludeProjects: includeProjects, MaxSensitivity: maxSensitivity,
		})
		if err != nil {
			return nil, err
		}
		shapeContent(results, contentMode)
		return map[string]any{"results": results}, nil

	case "memory_neighbors":
		id, _ := c.str("id", true, 1, 128)
		depth, _ := c.positiveInt("depth", 3)
		k, _ := c.positiveInt("k", 50)
		project, _ := c.projectRef("project")
		includeProjects, _ := c.strArray("includeProjects", 16, validProjectRefItem, "project ref contains control characters")
		maxSensitivity, _ := c.enum("maxSensitivity", "public", "internal", "private", "sensitive")
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, includeProjects, err := s.resolveScopeMCP(ctx, userID, project, includeProjects, true)
		if err != nil {
			return nil, err
		}
		outcome, err := s.engine.Neighbors(ctx, userID, engine.NeighborsArgs{
			ID: id, Depth: depth, K: k,
			Project: project, IncludeProjects: includeProjects, MaxSensitivity: maxSensitivity,
		})
		if err != nil {
			return nil, err
		}
		if outcome.Results == nil {
			outcome.Results = []engine.SearchResultItem{}
		}
		return map[string]any{"results": outcome.Results, "degraded": outcome.Degraded}, nil

	case "memory_forget":
		id, _ := c.str("id", true, 1, 128)
		project, _ := c.projectRef("project")
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, _, err := s.resolveScopeMCP(ctx, userID, project, nil, false)
		if err != nil {
			return nil, err
		}
		return s.engine.Forget(ctx, userID, id, project)

	case "memory_update":
		id, _ := c.str("id", true, 1, 128)
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
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, _, err := s.resolveScopeMCP(ctx, userID, req.Project, nil, false)
		if err != nil {
			return nil, err
		}
		req.Project = project
		return s.engine.Update(ctx, userID, id, req)

	case "memory_stats":
		checkStrict(c)
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		return s.engine.GetStats(ctx, userID)

	case "project_list":
		checkStrict(c)
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		rows, err := s.warm.ListProjectsForUser(ctx, userID)
		if err != nil {
			return nil, err
		}
		projects := make([]map[string]any, 0, len(rows))
		for _, r := range rows {
			projects = append(projects, map[string]any{
				"id": r.ID, "name": r.Name, "role": r.Role,
				"ownerUserId": r.OwnerUserID, "createdAt": jsTime(r.CreatedAt),
			})
		}
		return map[string]any{"projects": projects}, nil

	case "project_create":
		pname, _ := c.str("name", true, 1, 128)
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		p, err := s.warm.CreateProject(ctx, engine.NewULID(), pname, userID)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"id": p.ID, "name": p.Name, "ownerUserId": p.OwnerUserID, "createdAt": jsTime(p.CreatedAt),
		}, nil

	case "project_delete":
		project, err := s.requireOwnedProject(ctx, c, userID, "delete")
		if err != nil {
			return nil, err
		}
		return s.engine.DeleteProject(ctx, project.ID, project.OwnerUserID)

	case "project_activate":
		ref, _ := c.projectRef("project")
		if ref == nil && len(c.issues) == 0 {
			c.add("project", "Required", "invalid_type")
		}
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		project, _, err := s.resolveScopeMCP(ctx, userID, ref, nil, false)
		if err != nil {
			return nil, err
		}
		if project == nil {
			return nil, fmt.Errorf("project required")
		}
		if err := s.warm.SetActiveProject(ctx, userID, project); err != nil {
			return nil, err
		}
		return map[string]any{"active": *project}, nil

	case "project_deactivate":
		checkStrict(c)
		if err := firstIssue(c); err != nil {
			return nil, err
		}
		if err := s.warm.SetActiveProject(ctx, userID, nil); err != nil {
			return nil, err
		}
		return map[string]any{"active": nil}, nil

	case "project_share":
		username, _ := c.str("username", true, 1, 128)
		project, err := s.requireOwnedProject(ctx, c, userID, "share")
		if err != nil {
			return nil, err
		}
		target, err := s.warm.FindUserByExactEmail(ctx, username)
		if err != nil {
			return nil, err
		}
		// Exact email only — the fuzzy resolver matches self-settable
		// display names and would let an attacker be invited in a
		// target's place (see mcp.ts project_share note).
		if target == nil {
			return nil, fmt.Errorf("unknown user '%s' — share by exact email address", username)
		}
		added, err := s.warm.AddProjectMember(ctx, project.ID, target.ID, "member")
		if err != nil {
			return nil, err
		}
		return map[string]any{"added": added, "userId": target.ID, "username": target.Username}, nil

	case "project_unshare":
		username, _ := c.str("username", true, 1, 128)
		project, err := s.requireOwnedProject(ctx, c, userID, "unshare")
		if err != nil {
			return nil, err
		}
		target, err := s.warm.FindUserByExactEmail(ctx, username)
		if err != nil {
			return nil, err
		}
		if target == nil {
			return nil, fmt.Errorf("unknown user '%s' — unshare by exact email address", username)
		}
		if target.ID == project.OwnerUserID {
			return nil, fmt.Errorf("the owner cannot unshare themselves — delete the project instead")
		}
		removed, err := s.warm.RemoveProjectMember(ctx, project.ID, target.ID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"removed": removed}, nil

	default:
		return nil, mcp.ErrUnknownTool
	}
}

// requireOwnedProject — shared preamble of project_delete/share/unshare:
// validate the `project` arg, resolve it (with membership), load the
// row, and enforce ownership with the tool-specific message.
func (s *server) requireOwnedProject(ctx context.Context, c *v, userID, verb string) (*ownedProject, error) {
	ref, _ := c.projectRef("project")
	if ref == nil && len(c.issues) == 0 {
		c.add("project", "Required", "invalid_type")
	}
	if err := firstIssue(c); err != nil {
		return nil, err
	}
	project, _, err := s.resolveScopeMCP(ctx, userID, ref, nil, false)
	if err != nil {
		return nil, err
	}
	if project == nil {
		return nil, fmt.Errorf("project required")
	}
	info, err := s.warm.GetProjectInfo(ctx, *project)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return nil, fmt.Errorf("unknown project")
	}
	if info.OwnerUserID != userID {
		return nil, fmt.Errorf("only the owner can %s a project", verb)
	}
	return &ownedProject{ID: info.ID, OwnerUserID: info.OwnerUserID}, nil
}

type ownedProject struct {
	ID          string
	OwnerUserID string
}

// validProjectRefItem — includeProjects item rule (shared with the HTTP
// handlers' inline closures).
func validProjectRefItem(s string) bool {
	return utf16Len(s) >= 1 && utf16Len(s) <= 128 && projectRefRe.MatchString(s)
}
