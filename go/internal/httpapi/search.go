// Search-plane routes: /v1/{search,context,neighbors,hygiene,evaluate,
// adoption} and GET /v1/context-prefix. Transcribed from
// routes/data-plane.ts + routes/schemas.ts. Status codes, field names
// and message strings are contract — including the degraded-503 rule:
// "I found nothing" and "I could not look" are different claims, so a
// degraded search that produced nothing is a 503, while degraded WITH
// results stays a 200.
package httpapi

import (
	"net/http"
	"regexp"

	"github.com/azrtydxb/novamem/go/internal/engine"
)

func (s *server) registerSearchPlane(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/search", s.withAuth(s.handleSearch))
	mux.HandleFunc("POST /v1/context", s.withAuth(s.handleContext))
	mux.HandleFunc("POST /v1/neighbors", s.withAuth(s.handleNeighbors))
	mux.HandleFunc("POST /v1/hygiene", s.withAuth(s.handleHygiene))
	mux.HandleFunc("POST /v1/evaluate", s.withAuth(s.handleEvaluate))
	mux.HandleFunc("POST /v1/adoption", s.withAuth(s.handleAdoption))
	mux.HandleFunc("GET /v1/context-prefix", s.withAuth(s.handleContextPrefix))
}

// sendSearchResult — routes/data-plane.ts sendSearchResult: degraded
// with zero results is a 503 (the response carries no evidence about
// the caller's memory at all); degraded with results stays a 200.
func (s *server) sendSearchResult(w http.ResponseWriter, outcome engine.SearchOutcome) {
	results := orderedItems(outcome.Results)
	if outcome.Degraded && len(results) == 0 {
		writeJSONValue(w, http.StatusServiceUnavailable, obj{
			{"results", results},
			{"degraded", true},
			{"error", "search degraded: a backing tier was unavailable and no results could be produced"},
		})
		return
	}
	writeJSONValue(w, http.StatusOK, obj{
		{"results", results},
		{"degraded", outcome.Degraded},
	})
}

// orderedItems puts routes/data-plane.ts's field order back on the
// engine's map-shaped result rows. `signals` and `metadata` are absent
// on some shapes (contentMode=ids drops content+metadata; /v1/recent has
// no signals) — `ordered` skips keys that aren't there.
func orderedItems(items []engine.SearchResultItem) []obj {
	out := make([]obj, 0, len(items))
	for _, it := range items {
		m := map[string]any(it)
		orderedIn(m, "signals", "keyword", "vector", "graph", "recency", "entity")
		out = append(out, ordered(m, "id", "score", "content", "tier", "namespace",
			"project", "source", "metadata", "signals"))
	}
	return out
}

// orderedPack applies the same ordering to every section of a context
// pack (engine.BuildContextPack returns map[string][]SearchResultItem in
// context-pack.ts's own section order).
func orderedPack(pack map[string]any) obj {
	for k, v := range pack {
		if items, ok := v.([]engine.SearchResultItem); ok {
			pack[k] = orderedItems(items)
		}
	}
	return ordered(pack, "userGlobal", "projectScoped", "userPreferences", "currentSetup",
		"projectConventions", "decisions", "bugRootCauses", "deploymentState",
		"safetyConstraints", "pitfalls", "recentDecisions", "all")
}

// checkStrict rejects unknown keys for the .strict() bodies
// (AdoptionBody / HygieneBody / EvaluateBody in schemas.ts).
func checkStrict(c *v, allowed ...string) {
	ok := map[string]bool{}
	for _, k := range allowed {
		ok[k] = true
	}
	for key := range c.m {
		if !ok[key] {
			c.add("", `Unrecognized key: "`+key+`"`, "unrecognized_keys")
		}
	}
}

// parseWeights — SearchBody.weights: an object of five optional
// unbounded numbers; nil when absent.
func (c *v) parseWeights() *engine.WeightsOverride {
	raw, ok := c.m["weights"]
	if !ok || raw == nil {
		return nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		c.add("weights", "Invalid input: expected object, received "+jsonType(raw), "invalid_type")
		return nil
	}
	out := &engine.WeightsOverride{}
	get := func(key string) *float64 {
		v, ok := m[key]
		if !ok || v == nil {
			return nil
		}
		n, ok := v.(float64)
		if !ok {
			c.add("weights."+key, "Invalid input: expected number, received "+jsonType(v), "invalid_type")
			return nil
		}
		return &n
	}
	out.Keyword = get("keyword")
	out.Vector = get("vector")
	out.Graph = get("graph")
	out.Recency = get("recency")
	out.Entity = get("entity")
	return out
}

// tristate booleans (expandSourceChunks): nil = absent.
func (c *v) boolPtr(key string) *bool {
	raw, ok := c.m[key]
	if !ok || raw == nil {
		return nil
	}
	b, ok := raw.(bool)
	if !ok {
		c.add(key, "Invalid input: expected boolean, received "+jsonType(raw), "invalid_type")
		return nil
	}
	return &b
}

// agentName tri-state: absent (any agent) vs explicit null (agent IS
// NULL) vs a string — SearchBody agentName .optional().nullable() and
// the engine's `req.agentName === undefined ? undefined : (?? null)`.
func (c *v) agentName() (val *string, set bool) {
	raw, present := c.m["agentName"]
	if !present {
		return nil, false
	}
	if raw == nil {
		return nil, true
	}
	str, ok := raw.(string)
	if !ok {
		c.add("agentName", "Invalid input: expected string, received "+jsonType(raw), "invalid_type")
		return nil, false
	}
	if utf16Len(str) > 128 {
		c.add("agentName", "Too big: expected string to have <=128 characters", "too_big")
		return nil, false
	}
	return &str, true
}

func (s *server) handleSearch(w http.ResponseWriter, r *http.Request) {
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
	var args engine.SearchArgs
	args.Query, _ = c.str("query", true, 1, 8*1024)
	args.K, _ = c.positiveInt("k", 200)
	args.Namespace, _ = c.str("namespace", false, 0, 128)
	args.AgentName, args.AgentNameSet = c.agentName()
	args.Project, _ = c.projectRef("project")
	args.IncludeProjects, _ = c.strArray("includeProjects", 16, 1, 128,
		func(s string) bool { return utf16Len(s) >= 1 && utf16Len(s) <= 128 && projectRefRe.MatchString(s) },
		"project ref contains control characters")
	args.IncludeNamespaces, _ = c.strArray("includeNamespaces", 16, 1, 128, validNamespaceItem,
		"namespace must start alphanumeric and contain only letters, digits, dot, colon, underscore, or dash")
	args.Weights = c.parseWeights()
	contentMode, _ := c.enum("contentMode", "full", "snippet", "ids")
	args.MaxSensitivity, _ = c.enum("maxSensitivity", "public", "internal", "private", "sensitive")
	// asOf: validated for wire compatibility, no effect on search (TS
	// Phase 4 note — bitemporal filtering lives on /v1/neighbors' edges).
	c.datetime("asOf", "")
	// decompose opts into query decomposition + the coherence rerank;
	// with no decomposer configured the engine ignores it, as TS does.
	if d := c.boolPtr("decompose"); d != nil {
		args.Decompose = *d
	}
	args.ExpandSourceChunks = c.boolPtr("expandSourceChunks")
	args.Rerank, _ = c.boolean("rerank")
	if n, ok := c.number("minVectorScore", 0, 1); ok {
		args.MinVectorScore = &n
	}
	args.MaxTokens, _ = c.positiveInt("maxTokens", 1_000_000)
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

	outcome, err := s.engine.Search(r.Context(), userID, args)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	shapeContent(outcome.Results, contentMode)
	s.sendSearchResult(w, outcome)
}

// contextGuidance — routes/data-plane.ts /v1/context guidance string,
// byte-for-byte.
const contextGuidance = "Use this context before answering. Prefer contextPack sections over loose hits. For suggestion/recommendation/advice asks, DO answer: ground suggestions in the user's stored preferences, plans, and constraints from this context rather than declining or answering generically — measured on LongMemEval, declining these was the answerer's single largest error class. If the context holds nothing relevant about the user, say so briefly and give best general advice; never invent preferences. If relevant is empty, proceed but avoid asking the user to repeat context until targeted memory_search also misses."

func (s *server) handleContext(w http.ResponseWriter, r *http.Request) {
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
	message, _ := c.str("message", true, 1, 8*1024)
	k, kSet := c.positiveInt("k", 50)
	namespace, _ := c.str("namespace", false, 0, 128)
	project, _ := c.projectRef("project")
	includeProjects, _ := c.strArray("includeProjects", 16, 1, 128,
		func(s string) bool { return utf16Len(s) >= 1 && utf16Len(s) <= 128 && projectRefRe.MatchString(s) },
		"project ref contains control characters")
	includeNamespaces, _ := c.strArray("includeNamespaces", 16, 1, 128, validNamespaceItem,
		"namespace must start alphanumeric and contain only letters, digits, dot, colon, underscore, or dash")
	weights := c.parseWeights()
	maxSensitivity, _ := c.enum("maxSensitivity", "public", "internal", "private", "sensitive")
	c.datetime("asOf", "")
	c.boolPtr("decompose")
	expandSourceChunks := c.boolPtr("expandSourceChunks")
	maxTokens, maxTokensSet := c.positiveInt("maxTokens", 1_000_000)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	if !kSet {
		k = 8 // body.k ?? 8
	}
	if !maxTokensSet {
		// Prompt-assembly endpoint: the token budget defaults ON (6000 —
		// the Mem0-class retrieval budget), unlike /v1/search.
		maxTokens = 6000
	}
	userID := s.userID(r)
	scope := projectScope{Project: project, IncludeProjects: includeProjects}
	if !s.checkProjectAccess(w, r, userID, &scope, true) {
		return
	}

	relevant, err := s.engine.Search(r.Context(), userID, engine.SearchArgs{
		Query:              message,
		K:                  k,
		Namespace:          namespace,
		IncludeNamespaces:  includeNamespaces,
		Project:            scope.Project,
		IncludeProjects:    scope.IncludeProjects,
		Weights:            weights,
		MaxSensitivity:     maxSensitivity,
		MaxTokens:          maxTokens,
		ExpandSourceChunks: expandSourceChunks,
	})
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	recentK := k
	if recentK > 10 {
		recentK = 10
	}
	recentResults, err := s.engine.Recent(r.Context(), userID, engine.RecentArgs{
		K:                 recentK,
		Namespace:         namespace,
		IncludeNamespaces: includeNamespaces,
		Project:           scope.Project,
		IncludeProjects:   scope.IncludeProjects,
		MaxSensitivity:    maxSensitivity,
	})
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if relevant.Results == nil {
		relevant.Results = []engine.SearchResultItem{}
	}
	relevantBody := obj{{"results", orderedItems(relevant.Results)}, {"degraded", relevant.Degraded}}
	recentBody := obj{{"results", orderedItems(recentResults)}}
	// Same rule as /v1/search: a degraded search that produced nothing is
	// a 503 here too — the guidance text literally tells the caller to
	// proceed, so an outage must not read as "the store is empty".
	if relevant.Degraded && len(relevant.Results) == 0 {
		writeJSONValue(w, http.StatusServiceUnavailable, obj{
			{"relevant", relevantBody},
			{"recent", recentBody},
			{"error", "context degraded: a backing tier was unavailable and no relevant memories could be produced"},
		})
		return
	}
	writeJSONValue(w, http.StatusOK, obj{
		{"relevant", relevantBody},
		{"recent", recentBody},
		{"contextPack", orderedPack(engine.BuildContextPack(relevant.Results, recentResults))},
		{"guidance", contextGuidance},
	})
}

func (s *server) handleNeighbors(w http.ResponseWriter, r *http.Request) {
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
	var args engine.NeighborsArgs
	args.ID, _ = c.str("id", true, 1, 128)
	args.Depth, _ = c.positiveInt("depth", 3)
	args.K, _ = c.positiveInt("k", 50)
	args.Project, _ = c.projectRef("project")
	args.IncludeProjects, _ = c.strArray("includeProjects", 16, 1, 128,
		func(s string) bool { return utf16Len(s) >= 1 && utf16Len(s) <= 128 && projectRefRe.MatchString(s) },
		"project ref contains control characters")
	args.IncludeNamespaces, _ = c.strArray("includeNamespaces", 16, 1, 128, validNamespaceItem,
		"namespace must start alphanumeric and contain only letters, digits, dot, colon, underscore, or dash")
	args.MaxSensitivity, _ = c.enum("maxSensitivity", "public", "internal", "private", "sensitive")
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

	outcome, err := s.engine.Neighbors(r.Context(), userID, args)
	if err != nil {
		// routes/data-plane.ts /v1/neighbors catch: the walk failed and
		// produced nothing, so the caller learns nothing about this
		// seed's neighbours — say so with a 503.
		s.log.Warn("[/v1/neighbors] degraded", "err", err)
		writeJSONValue(w, http.StatusServiceUnavailable, obj{
			{"seed", args.ID},
			{"results", []obj{}},
			{"degraded", true},
			{"error", "neighbors degraded: graph traversal failed and no results could be produced"},
		})
		return
	}
	s.sendSearchResult(w, outcome)
}

func (s *server) handleHygiene(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	m, decodeErr := decodeBody(body, true) // HygieneBody.optional()
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return
	}
	c := &v{m: m}
	checkStrict(c, "k")
	k, _ := c.positiveInt("k", 100)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	report, err := s.engine.HygieneReport(r.Context(), s.userID(r), k)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, orderedHygiene(report))
}

// orderedHygiene puts routes/hygiene.ts's key order back on the engine's
// map-shaped report.
func orderedHygiene(report map[string]any) obj {
	orderedIn(report, "summary", "scanned", "lowValue", "stale",
		"duplicateClusters", "contradictionCandidates", "orphanCandidates")
	return ordered(report, "summary", "lowValue", "stale",
		"duplicateClusters", "contradictionCandidates", "orphanCandidates")
}

func (s *server) handleEvaluate(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	m, decodeErr := decodeBody(body, true) // EvaluateBody.optional()
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return
	}
	c := &v{m: m}
	checkStrict(c, "suite")
	suite, _ := c.str("suite", false, 1, 64)
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	report, err := s.engine.EvaluateMemoryQuality(r.Context(), s.userID(r), suite)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	orderedIn(report, "summary", "total", "passed", "failed")
	if h, ok := report["hygiene"].(map[string]any); ok {
		report["hygiene"] = orderedHygiene(h)
	}
	writeJSONValue(w, http.StatusOK,
		ordered(report, "suite", "passed", "summary", "cases", "checks", "hygiene"))
}

var instructionsHashRe = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func (s *server) handleAdoption(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	m, decodeErr := decodeBody(body, true) // AdoptionBody.optional()
	if decodeErr != nil {
		s.sendBodyErr(w, decodeErr)
		return
	}
	c := &v{m: m}
	checkStrict(c, "client", "observedTools", "observedInstructionsHash")
	var opts adoptionOptions
	opts.Client, _ = c.str("client", false, 0, 64)
	if tools, ok := c.strArray("observedTools", 128, 1, 128, noItemRule, ""); ok {
		opts.ObservedTools = tools
		opts.ObservedToolsSet = true
	}
	if hash, ok := c.str("observedInstructionsHash", false, 0, 1<<30); ok {
		if !instructionsHashRe.MatchString(hash) {
			c.add("observedInstructionsHash", `Invalid string: must match pattern /^[a-fA-F0-9]{64}$/`, "invalid_format")
		} else {
			opts.ObservedInstructionsHash = &hash
		}
	}
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	writeJSONValue(w, http.StatusOK, buildAdoptionReport(opts))
}

// handleContextPrefix — the cacheable per-(user, project) observation
// prefix. With NOVAMEM_OBSERVER_ENABLED off the engine returns nil and
// this answers 404 {"error":"observer disabled"}, exactly as TS does
// (routes/data-plane.ts /v1/context-prefix).
func (s *server) handleContextPrefix(w http.ResponseWriter, r *http.Request) {
	// `project` is used verbatim as the scope key, without the
	// project-ref resolution the write routes perform — TS passes the raw
	// query value straight through to getContextPrefix.
	var project *string
	if q := r.URL.Query(); q.Has("project") {
		raw := q.Get("project")
		project = &raw
	}
	prefix, err := s.engine.GetContextPrefix(r.Context(), s.userID(r), project)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if prefix == nil {
		s.sendError(w, http.StatusNotFound, "observer disabled")
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"prefix": *prefix})
}
