// Hybrid search, neighbors, context pack, hygiene, evaluate.
// Transcribed from packages/server/src/engine/index.ts (search,
// neighbors, buildContextPack, hygieneReport, evaluateMemoryQuality)
// — read-only reference, never imported.
//
// Not ported (feature not configured in the Go server, matching TS with
// the corresponding config unset): query decomposition (`decompose` is
// accepted and ignored — TS ignores it without a decomposer), the
// coherence rerank (decomposer-gated), fact extraction (extractor-gated)
// and the observer. `asOf` is accepted for wire compatibility and has no
// effect on search, exactly as in TS (Phase 4 note).
package engine

import (
	"context"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/azrtydxb/novamem/go/internal/coldstore"
	"github.com/azrtydxb/novamem/go/internal/embeddings"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

var (
	// buildContextPack's content heuristics (engine/index.ts).
	pitfallRe      = regexp.MustCompile(`(?i)pitfall|warning|avoid|do not|don't|must not|gotcha`)
	decisionWordRe = regexp.MustCompile(`(?i)\bdecision\b`)
)

func trimSpace(s string) string { return strings.TrimSpace(s) }

// Candidates fetched per requested result (engine/index.ts OVERFETCH_FACTOR).
const overfetchFactor = 3

// Two results whose token sets overlap at least this much are
// restatements; only the higher-ranked one is returned.
const resultDiversityMaxJaccard = 0.75

// WeightsOverride mirrors SearchBody.weights: per-field optional
// overrides spread over DEFAULT_WEIGHTS (an explicit 0 disables a tier).
type WeightsOverride struct {
	Keyword *float64
	Vector  *float64
	Graph   *float64
	Recency *float64
	Entity  *float64
}

type SearchArgs struct {
	Query             string
	K                 int // 0 → 10
	Namespace         string
	AgentName         *string
	AgentNameSet      bool
	Project           *string
	IncludeProjects   []string
	IncludeNamespaces []string
	Weights           *WeightsOverride
	MaxSensitivity    string
	// Rerank opts into the Phase 5 cross-encoder pass (requires a
	// configured reranker; silently ignored otherwise, as in TS).
	Rerank bool
	// nil → engine default; explicit 0 disables the noise floor.
	MinVectorScore *float64
	// 0 = no token budget.
	MaxTokens int
	// nil → default true (engine/index.ts `req.expandSourceChunks !== false`).
	ExpandSourceChunks *bool
}

type SearchOutcome struct {
	Results  []SearchResultItem
	Degraded bool
}

func (e *Engine) resolveDefaultNamespaces(ctx context.Context, userID string, project *string, includeProjects []string) ([]string, error) {
	ns, err := e.warm.ListNamespaces(ctx, userID, project, includeProjects)
	if err != nil {
		return nil, err
	}
	if len(ns) == 0 {
		return []string{"default"}, nil
	}
	return ns, nil
}

// Search — engine/index.ts search(). Tier order and degradation
// semantics preserved: a failed tier degrades the search (empty tier
// output, degraded=true) rather than failing the request; the HTTP
// layer turns degraded-with-zero-results into a 503.
func (e *Engine) Search(ctx context.Context, userID string, req SearchArgs) (SearchOutcome, error) {
	k := req.K
	if k == 0 {
		k = 10
	}
	weights := DefaultWeights
	if w := req.Weights; w != nil {
		if w.Keyword != nil {
			weights.Keyword = *w.Keyword
		}
		if w.Vector != nil {
			weights.Vector = *w.Vector
		}
		if w.Graph != nil {
			weights.Graph = *w.Graph
		}
		if w.Recency != nil {
			weights.Recency = *w.Recency
		}
		if w.Entity != nil {
			weights.Entity = *w.Entity
		}
	}

	// Active-project mode: fan out across (user-global) ∪ each project.
	var scopes []*string
	if len(req.IncludeProjects) > 0 {
		scopes = append(scopes, nil)
		for i := range req.IncludeProjects {
			scopes = append(scopes, &req.IncludeProjects[i])
		}
	} else {
		scopes = []*string{req.Project}
	}

	// Namespace fanout: includeNamespaces > namespace > every namespace
	// with visible entries (fresh callers fall back to ["default"]).
	var namespaces []string
	switch {
	case len(req.IncludeNamespaces) > 0:
		namespaces = req.IncludeNamespaces
	case req.Namespace != "":
		namespaces = []string{req.Namespace}
	default:
		ns, err := e.resolveDefaultNamespaces(ctx, userID, req.Project, req.IncludeProjects)
		if err != nil {
			return SearchOutcome{}, err
		}
		namespaces = ns
	}

	// Embed the query ("query" side of the asymmetric prefix pair). A
	// dead embedder is a failed tier, not a failed request — but it must
	// mark the search degraded or an outage looks like "nothing matched".
	degraded := false
	var queryEmbedding []float64
	if e.embedder == nil {
		degraded = true
	} else if vecs, err := e.embedder.Embed(ctx, []string{req.Query}, embeddings.KindQuery); err != nil {
		degraded = true
		e.recordEmbedFailure(err, "search", "")
	} else if len(vecs) > 0 {
		queryEmbedding = vecs[0]
	}

	// Keyword tier. A tier weighted 0 is pure latency — skipped, like TS.
	// One failure empties the whole tier (TS wraps the fan-out in a
	// single Promise.all with one catch).
	var keywordHits []warmstore.ScoredID
	if weights.Keyword != 0 {
		for _, projectID := range scopes {
			var nsList []string
			if len(namespaces) > 1 {
				nsList = namespaces
			}
			hits, err := e.warm.FtsSearch(ctx, warmstore.FtsArgs{
				UserID:       userID,
				ProjectID:    projectID,
				Query:        req.Query,
				Namespace:    namespaces[0],
				Namespaces:   nsList,
				K:            k * 3,
				AgentName:    req.AgentName,
				AgentNameSet: req.AgentNameSet,
			})
			if err != nil {
				degraded = true
				e.log.Warn("keyword tier failed", "err", err)
				keywordHits = nil
				break
			}
			keywordHits = append(keywordHits, hits...)
		}
	}

	// Vector tier: one cold search per (scope × namespace).
	var vectorHits []coldstore.Hit
	if queryEmbedding != nil && e.cold != nil {
	vectorLoop:
		for _, projectID := range scopes {
			for _, namespace := range namespaces {
				hits, err := e.cold.Search(ctx, coldstore.SearchArgs{
					UserID:    userID,
					ProjectID: projectID,
					Namespace: namespace,
					Embedding: queryEmbedding,
					K:         k * 3,
				})
				if err != nil {
					degraded = true
					e.log.Warn("vector tier failed", "err", err)
					vectorHits = nil
					break vectorLoop
				}
				vectorHits = append(vectorHits, hits...)
			}
		}
	}

	// Single-scope path keeps the original projectId for downstream
	// lookups; multi-scope uses nil + per-id resolution via includeProjects.
	var projectID *string
	if len(scopes) == 1 {
		projectID = scopes[0]
	}

	// Pre-fetch entries for the union of candidate ids so recency +
	// entity signals can join the fusion.
	seen := map[string]bool{}
	var candidateIDs []string
	for _, h := range keywordHits {
		if !seen[h.ID] {
			seen[h.ID] = true
			candidateIDs = append(candidateIDs, h.ID)
		}
	}
	for _, h := range vectorHits {
		if !seen[h.ID] {
			seen[h.ID] = true
			candidateIDs = append(candidateIDs, h.ID)
		}
	}
	entryByID := map[string]*warmstore.Entry{}
	if len(candidateIDs) > 0 {
		entries, err := e.warm.GetEntries(ctx, userID, candidateIDs, projectID, req.IncludeProjects)
		if err != nil {
			return SearchOutcome{}, err
		}
		for i, entry := range entries {
			if entry != nil {
				entryByID[candidateIDs[i]] = entry
			}
		}
	}
	queryEntities := ExtractQueryEntities(req.Query)

	// ── Fusion ─────────────────────────────────────────────────────────
	var inputs []HybridInput
	for _, h := range keywordHits {
		s := h.Score
		inputs = append(inputs, HybridInput{ID: h.ID, Signals: HybridSignal{Keyword: &s}})
	}
	for _, h := range vectorHits {
		s := h.Score
		inputs = append(inputs, HybridInput{ID: h.ID, Signals: HybridSignal{Vector: &s}})
	}
	now := e.now()
	for _, id := range candidateIDs {
		entry := entryByID[id]
		if entry == nil {
			continue
		}
		// Recency: exp(-ageDays / 180) over updated_at.
		ageDays := now.Sub(entry.UpdatedAt).Hours() / 24
		if score := RecencyScore(ageDays, 180); score > 0 {
			s := score
			inputs = append(inputs, HybridInput{ID: id, Signals: HybridSignal{Recency: &s}})
		}
		if len(queryEntities) > 0 && entry.Content != "" {
			if score := EntityMatchScore(entry.Content, queryEntities); score > 0 {
				s := score
				inputs = append(inputs, HybridInput{ID: id, Signals: HybridSignal{Entity: &s}})
			}
		}
	}
	minVector := e.minVectorScore
	if req.MinVectorScore != nil {
		minVector = *req.MinVectorScore
	}
	fused := Fuse(inputs, weights, minVector)
	if len(fused) > k*overfetchFactor {
		fused = fused[:k*overfetchFactor]
	}

	// Importance-weighted boost for fact memories: metadata.fact.importance
	// (1..5, neutral 3) multiplies the fused score; raw chunks get 1.0.
	for i := range fused {
		boost := 1.0
		if entry := entryByID[fused[i].ID]; entry != nil {
			if fact, ok := entry.Metadata["fact"].(map[string]any); ok {
				if imp, ok := fact["importance"].(float64); ok {
					boost = math.Max(1, math.Min(5, imp)) / 3
				}
			}
		}
		fused[i].Score *= boost
	}
	sort.SliceStable(fused, func(a, b int) bool { return fused[a].Score > fused[b].Score })
	// Deliberately NOT truncated to k here: the visibility filter drops
	// superseded/sensitivity-hidden rows; cutting to k first is exactly
	// the recall bug the over-fetch exists to prevent.

	// Pre-fetch promotion stats for cold hits in one round-trip.
	var coldHitIDs []string
	for _, f := range fused {
		if entry := entryByID[f.ID]; entry != nil && entry.Cold {
			coldHitIDs = append(coldHitIDs, f.ID)
		}
	}
	coldStats := map[string]warmstore.ColdStats{}
	if len(coldHitIDs) > 0 {
		var err error
		coldStats, err = e.warm.GetColdEntryStatsMany(ctx, coldHitIDs)
		if err != nil {
			return SearchOutcome{}, err
		}
	}

	// ── Visibility filter → rank prior ─────────────────────────────────
	type visibleItem struct {
		result SearchResultItem
		entry  *warmstore.Entry
		score  float64
	}
	var visible []*visibleItem
	for _, f := range fused {
		entry := entryByID[f.ID]
		if entry == nil {
			continue
		}
		if isInactiveMemory(entry.Metadata) {
			continue
		}
		if !isSensitivityVisible(entry.Metadata, req.MaxSensitivity) {
			continue
		}
		ageDays := now.Sub(entry.CreatedAt).Hours() / 24
		memoryType, _ := entry.Metadata["memoryType"].(string)
		confidence := entry.Confidence
		prior := RankPrior(&confidence, memoryType, &ageDays)
		tier := "warm"
		if entry.Cold {
			tier = "cold"
		}
		var project any
		if entry.ProjectID != nil {
			project = *entry.ProjectID
		}
		visible = append(visible, &visibleItem{
			entry: entry,
			score: f.Score * prior,
			result: SearchResultItem{
				"id":        f.ID,
				"score":     f.Score * prior,
				"content":   entry.Content,
				"tier":      tier,
				"namespace": entry.Namespace,
				"project":   project,
				"source":    entry.Source,
				"metadata":  entry.Metadata,
				"signals":   f.Signals,
			},
		})
	}
	sort.SliceStable(visible, func(a, b int) bool { return visible[a].score > visible[b].score })

	// ── Phase 5 EXPERIMENT: cross-encoder rerank ───────────────────────
	// Opt-in per request AND requires a configured service. Scored
	// candidates re-order by cross-encoder relevance ahead of unscored
	// ones (which keep fused order); a rerank failure falls back to the
	// fused order — an enhancement outage must not fail the search.
	if req.Rerank && e.reranker != nil && len(visible) > 1 {
		pool := len(visible)
		if maxPool := k * e.rerankPoolMult; pool > maxPool {
			pool = maxPool
		}
		docs := make([]string, pool)
		for i := 0; i < pool; i++ {
			docs[i], _ = visible[i].result["content"].(string)
		}
		scores, err := e.reranker.Rerank(ctx, req.Query, docs)
		if err != nil {
			e.log.Warn("rerank failed; using fused order", "err", err)
		} else {
			order := map[*visibleItem]int{}
			for i, v := range visible {
				order[v] = i
			}
			sort.SliceStable(visible, func(a, b int) bool {
				ia, ib := order[visible[a]], order[visible[b]]
				var sa, sb *float64
				if ia < pool {
					sa = scores[ia]
				}
				if ib < pool {
					sb = scores[ib]
				}
				switch {
				case sa != nil && sb != nil:
					return *sa > *sb
				case sa != nil:
					return true
				case sb != nil:
					return false
				default:
					return ia < ib
				}
			})
		}
	}

	// ── Diversify + token budget + truncate ────────────────────────────
	tokenCache := map[string]map[string]bool{}
	tokensFor := func(content string) map[string]bool {
		t, ok := tokenCache[content]
		if !ok {
			t = contentTokens(content)
			tokenCache[content] = t
		}
		return t
	}
	tokenBudget := 0
	if req.MaxTokens > 0 {
		tokenBudget = req.MaxTokens
	}
	spent := 0
	var selected []*visibleItem
	for _, cand := range visible {
		if len(selected) >= k {
			break
		}
		content, _ := cand.result["content"].(string)
		cost := EstimateTokens(content)
		candTokens := tokensFor(content)
		redundant := false
		for _, s := range selected {
			sc, _ := s.result["content"].(string)
			if jaccardOf(tokensFor(sc), candTokens) >= resultDiversityMaxJaccard {
				redundant = true
				break
			}
		}
		if redundant {
			continue
		}
		// Always admit the first result: a budget smaller than the top
		// hit should return that hit rather than nothing.
		if tokenBudget > 0 && len(selected) > 0 && spent+cost > tokenBudget {
			break
		}
		selected = append(selected, cand)
		spent += cost
	}
	// Backfill from what diversification dropped rather than
	// under-returning (only without a token budget), then restore
	// descending score order.
	if len(selected) < k && tokenBudget == 0 {
		chosen := map[*visibleItem]bool{}
		for _, s := range selected {
			chosen[s] = true
		}
		for _, cand := range visible {
			if len(selected) >= k {
				break
			}
			if chosen[cand] {
				continue
			}
			selected = append(selected, cand)
		}
		sort.SliceStable(selected, func(a, b int) bool { return selected[a].score > selected[b].score })
	}

	// ── Assemble + promotion + hit bumps ───────────────────────────────
	results := make([]SearchResultItem, 0, len(selected))
	var idsToBump []string
	for _, item := range selected {
		id, _ := item.result["id"].(string)
		idsToBump = append(idsToBump, id)
		// Cold→warm promotion: pre-bump stats gate promotion — an entry
		// earns warm status when its post-bump lifespan exceeds how long
		// it had been idle before this hit (engine/index.ts maybePromote).
		if item.entry.Cold {
			if preBump, ok := coldStats[id]; ok {
				lifespan := EffectiveDays(preBump.Hits + 1)
				if lifespan > preBump.IdleDays {
					if err := e.warm.MarkCold(ctx, id, false); err == nil {
						item.result["tier"] = "warm"
						e.promotedSinceLastDecay.Add(1)
						if e.metrics != nil {
							e.metrics.RecordPromotion(1)
						}
					} else {
						e.log.Warn("cold→warm promotion failed", "entryId", id, "err", err)
					}
				}
			}
		}
		results = append(results, item.result)
	}
	if len(idsToBump) > 0 {
		// Bookkeeping, not response content — async, failures only cost
		// decay/promotion signal (engine/index.ts bumpHitsMany void).
		go func(ids []string) {
			bg, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := e.warm.BumpHitsMany(bg, ids); err != nil {
				e.log.Warn("async bumpHitsMany failed (hit counts lag)", "err", err)
			}
		}(idsToBump)
	}

	// ── Auto-expand source_chunk for fact memories ─────────────────────
	// Inline the raw chunk's text as metadata.sourceText so answerer
	// LLMs see the compressed fact AND the supporting conversation.
	if req.ExpandSourceChunks == nil || *req.ExpandSourceChunks {
		var sourceIDs []string
		seenSrc := map[string]bool{}
		for _, r := range results {
			if meta, ok := r["metadata"].(map[string]any); ok {
				if srcID, ok := meta["source_chunk_id"].(string); ok && !seenSrc[srcID] {
					seenSrc[srcID] = true
					sourceIDs = append(sourceIDs, srcID)
				}
			}
		}
		if len(sourceIDs) > 0 {
			srcRows, err := e.warm.GetEntries(ctx, userID, sourceIDs, projectID, req.IncludeProjects)
			if err != nil {
				e.log.Warn("source-chunk auto-expand failed (returning facts without sourceText)", "err", err)
			} else {
				contentByID := map[string]string{}
				for i, row := range srcRows {
					if row != nil {
						contentByID[sourceIDs[i]] = row.Content
					}
				}
				for _, r := range results {
					meta, ok := r["metadata"].(map[string]any)
					if !ok {
						continue
					}
					srcID, ok := meta["source_chunk_id"].(string)
					if !ok {
						continue
					}
					if text, ok := contentByID[srcID]; ok {
						// New map, not in-place: the entry's metadata is shared.
						withText := map[string]any{}
						for mk, mv := range meta {
							withText[mk] = mv
						}
						withText["sourceText"] = text
						r["metadata"] = withText
					}
				}
			}
		}
	}

	return SearchOutcome{Results: results, Degraded: degraded}, nil
}

type NeighborsArgs struct {
	ID              string
	Depth           int // 0 → 1
	K               int // 0 → 10
	Project         *string
	IncludeProjects []string
	// IncludeNamespaces accepted for API symmetry, unused (TS comment:
	// entry resolution picks up the entry's actual namespace).
	IncludeNamespaces []string
	MaxSensitivity    string
}

// Neighbors — engine/index.ts neighbors(): served from memory_relations.
// The seed's actual scope binds the traversal; a relations-query failure
// answers {results: [], degraded: true} rather than an error.
func (e *Engine) Neighbors(ctx context.Context, userID string, args NeighborsArgs) (SearchOutcome, error) {
	depth := args.Depth
	if depth == 0 {
		depth = 1
	}
	k := args.K
	if k == 0 {
		k = 10
	}
	var seed *warmstore.Entry
	if len(args.IncludeProjects) > 0 {
		rows, err := e.warm.GetEntries(ctx, userID, []string{args.ID}, nil, args.IncludeProjects)
		if err != nil {
			return SearchOutcome{}, err
		}
		if len(rows) > 0 {
			seed = rows[0]
		}
	} else {
		var err error
		seed, err = e.warm.GetEntry(ctx, userID, args.ID, args.Project)
		if err != nil {
			return SearchOutcome{}, err
		}
	}
	if seed == nil {
		return SearchOutcome{Results: []SearchResultItem{}, Degraded: false}, nil
	}
	seedScope := seed.ProjectID
	hits, err := e.warm.NeighborsByRelations(ctx, userID, args.ID, depth, k, seedScope)
	if err != nil {
		e.log.Warn("[engine.neighbors] relations query failed — returning degraded",
			"err", err, "depth", depth, "seedId", args.ID)
		return SearchOutcome{Results: []SearchResultItem{}, Degraded: true}, nil
	}
	results := []SearchResultItem{}
	for _, h := range hits {
		var entry *warmstore.Entry
		if len(args.IncludeProjects) > 0 {
			rows, err := e.warm.GetEntries(ctx, userID, []string{h.ID}, nil, args.IncludeProjects)
			if err != nil {
				return SearchOutcome{}, err
			}
			if len(rows) > 0 {
				entry = rows[0]
			}
		} else {
			entry, err = e.warm.GetEntry(ctx, userID, h.ID, args.Project)
			if err != nil {
				return SearchOutcome{}, err
			}
		}
		if entry == nil {
			continue
		}
		if !isSensitivityVisible(entry.Metadata, args.MaxSensitivity) {
			continue
		}
		tier := "warm"
		if entry.Cold {
			tier = "cold"
		}
		var project any
		if entry.ProjectID != nil {
			project = *entry.ProjectID
		}
		results = append(results, SearchResultItem{
			"id":        h.ID,
			"score":     h.Score,
			"content":   entry.Content,
			"tier":      tier,
			"namespace": entry.Namespace,
			"project":   project,
			"source":    entry.Source,
			"metadata":  entry.Metadata,
			// Only the graph signal is applicable; keyword/vector omitted
			// so consumers can tell "not applicable" from "scored zero".
			"signals": map[string]any{"graph": h.Score},
		})
	}
	return SearchOutcome{Results: results, Degraded: false}, nil
}

// BuildContextPack — engine/index.ts buildContextPack. Items are the
// SearchResultItem maps the routes already hold; dedup by id with
// later items (recent) winning, exactly like the TS Map building.
func BuildContextPack(relevant, recent []SearchResultItem) map[string]any {
	byID := map[string]SearchResultItem{}
	var order []string
	for _, item := range append(append([]SearchResultItem{}, relevant...), recent...) {
		id, _ := item["id"].(string)
		if _, ok := byID[id]; !ok {
			order = append(order, id)
		}
		byID[id] = item
	}
	all := make([]SearchResultItem, 0, len(order))
	for _, id := range order {
		all = append(all, byID[id])
	}
	memoryTypeOf := func(r SearchResultItem) string {
		meta, _ := r["metadata"].(map[string]any)
		t, _ := meta["memoryType"].(string)
		return t
	}
	namespaceOf := func(r SearchResultItem) string {
		ns, _ := r["namespace"].(string)
		return ns
	}
	contentOf := func(r SearchResultItem) string {
		c, _ := r["content"].(string)
		return c
	}
	byType := func(types []string, extra func(SearchResultItem) bool) []SearchResultItem {
		out := []SearchResultItem{}
		for _, r := range all {
			match := false
			for _, t := range types {
				if memoryTypeOf(r) == t {
					match = true
					break
				}
			}
			if !match && extra != nil && extra(r) {
				match = true
			}
			if match {
				out = append(out, r)
			}
		}
		return out
	}
	filter := func(pred func(SearchResultItem) bool) []SearchResultItem {
		out := []SearchResultItem{}
		for _, r := range all {
			if pred(r) {
				out = append(out, r)
			}
		}
		return out
	}
	recentDecisions := []SearchResultItem{}
	for _, r := range recent {
		if memoryTypeOf(r) == "decision" || decisionWordRe.MatchString(contentOf(r)) {
			recentDecisions = append(recentDecisions, r)
		}
	}
	return map[string]any{
		"userGlobal":    filter(func(r SearchResultItem) bool { return r["project"] == nil }),
		"projectScoped": filter(func(r SearchResultItem) bool { return r["project"] != nil }),
		"userPreferences": byType([]string{"user_preference"}, func(r SearchResultItem) bool {
			return namespaceOf(r) == "user"
		}),
		"currentSetup": byType([]string{"setup_fact", "deployment_state"}, func(r SearchResultItem) bool {
			ns := namespaceOf(r)
			return ns == "current-setup" || ns == "setup"
		}),
		"projectConventions": byType([]string{"project_convention"}, nil),
		"decisions": byType([]string{"decision"}, func(r SearchResultItem) bool {
			return namespaceOf(r) == "decisions"
		}),
		"bugRootCauses":     byType([]string{"bug_root_cause"}, nil),
		"deploymentState":   byType([]string{"deployment_state"}, nil),
		"safetyConstraints": byType([]string{"safety_constraint"}, nil),
		"pitfalls": filter(func(r SearchResultItem) bool {
			return pitfallRe.MatchString(contentOf(r))
		}),
		"recentDecisions": recentDecisions,
		"all":             all,
	}
}

// HygieneReport — engine/index.ts hygieneReport. O(n²) pairwise scan by
// design (bounded by scanLimit); the cold existence probe uses the same
// scope-disciplined existingIds the TS report does.
func (e *Engine) HygieneReport(ctx context.Context, userID string, k int) (map[string]any, error) {
	if k == 0 {
		k = 20
	}
	scanLimit := k * 20
	if scanLimit < 100 {
		scanLimit = 100
	}
	all, err := e.warm.ListHygieneEntries(ctx, userID, scanLimit)
	if err != nil {
		return nil, err
	}
	rows := make([]warmstore.HygieneEntry, 0, len(all))
	for _, r := range all {
		if !isInactiveMemory(r.Metadata) {
			rows = append(rows, r)
		}
	}

	lowValue := []map[string]any{}
	for _, r := range rows {
		if len(lowValue) >= k {
			break
		}
		overall := 1.0
		if w, ok := r.Metadata["worthiness"].(map[string]any); ok {
			if o, ok := w["overall"].(float64); ok {
				overall = o
			}
		}
		if overall < 0.35 || utf16Len(trimSpace(r.Content)) < 20 {
			lowValue = append(lowValue, map[string]any{"id": r.ID, "content": r.Content, "reason": "low_worthiness"})
		}
	}
	duplicateClusters := []map[string]any{}
	contradictionCandidates := []map[string]any{}
	for i := 0; i < len(rows); i++ {
		for j := i + 1; j < len(rows); j++ {
			a, b := rows[i], rows[j]
			if a.Namespace != b.Namespace || !projectEq(a.ProjectID, b.ProjectID) {
				continue
			}
			if TokenJaccard(a.Content, b.Content) >= 0.5 {
				duplicateClusters = append(duplicateClusters, map[string]any{
					"ids": []string{a.ID, b.ID}, "reason": "high_token_overlap"})
			}
			if LooksContradictory(a.Content, b.Content) {
				contradictionCandidates = append(contradictionCandidates, map[string]any{
					"ids": []string{a.ID, b.ID}, "reason": "comparable_scalar_conflict"})
			}
		}
	}
	orphanCandidates := []map[string]any{}
	if e.cold != nil {
		refs := make([]coldstore.EntryRef, len(rows))
		for i, r := range rows {
			refs[i] = coldstore.EntryRef{ID: r.ID, UserID: r.UserID, ProjectID: r.ProjectID, Namespace: r.Namespace}
		}
		coldIDs, err := e.cold.ExistingIds(ctx, refs)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			if len(orphanCandidates) >= k {
				break
			}
			if !coldIDs[r.ID] {
				orphanCandidates = append(orphanCandidates, map[string]any{"id": r.ID, "reason": "warm_without_cold_vector"})
			}
		}
	} else {
		// No cold store wired: every warm row reads as vectorless, which
		// would flood the report — mirror the TS behaviour instead by
		// reporting all rows as orphans (TS with an unreachable cold
		// store throws; a nil store here only exists in unit tests).
		for _, r := range rows {
			if len(orphanCandidates) >= k {
				break
			}
			orphanCandidates = append(orphanCandidates, map[string]any{"id": r.ID, "reason": "warm_without_cold_vector"})
		}
	}
	stale := []map[string]any{}
	for _, r := range rows {
		if len(stale) >= k {
			break
		}
		memoryType, _ := r.Metadata["memoryType"].(string)
		if memoryType != "setup_fact" && memoryType != "deployment_state" {
			continue
		}
		status, _ := r.Metadata["lifecycleStatus"].(string)
		if status == "" {
			status = "active"
		}
		if status == "superseded" || status == "deprecated" {
			continue
		}
		stale = append(stale, map[string]any{"id": r.ID, "reason": "current_state_review"})
	}
	if len(duplicateClusters) > k {
		duplicateClusters = duplicateClusters[:k]
	}
	if len(contradictionCandidates) > k {
		contradictionCandidates = contradictionCandidates[:k]
	}
	return map[string]any{
		"summary": map[string]any{
			"scanned":                 len(rows),
			"lowValue":                len(lowValue),
			"stale":                   len(stale),
			"duplicateClusters":       len(duplicateClusters),
			"contradictionCandidates": len(contradictionCandidates),
			"orphanCandidates":        len(orphanCandidates),
		},
		"lowValue":                lowValue,
		"stale":                   stale,
		"duplicateClusters":       duplicateClusters,
		"contradictionCandidates": contradictionCandidates,
		"orphanCandidates":        orphanCandidates,
	}, nil
}

// EvaluateMemoryQuality — engine/index.ts evaluateMemoryQuality: the
// built-in self-check suite over the engine's own invariants.
func (e *Engine) EvaluateMemoryQuality(ctx context.Context, userID, suite string) (map[string]any, error) {
	contextPack := BuildContextPack([]SearchResultItem{
		{"id": "pref", "content": "pref", "score": 1.0, "tier": "warm", "namespace": "user", "project": nil, "source": "eval", "metadata": map[string]any{"memoryType": "user_preference"}},
		{"id": "decision", "content": "decision", "score": 1.0, "tier": "warm", "namespace": "decisions", "project": nil, "source": "eval", "metadata": map[string]any{"memoryType": "decision"}},
		{"id": "setup", "content": "setup", "score": 1.0, "tier": "warm", "namespace": "setup", "project": nil, "source": "eval", "metadata": map[string]any{"memoryType": "setup_fact"}},
	}, []SearchResultItem{})
	hygiene, err := e.HygieneReport(ctx, userID, 5)
	if err != nil {
		return nil, err
	}
	summary, _ := hygiene["summary"].(map[string]any)
	hygieneShapeOk := summary != nil
	if hygieneShapeOk {
		if _, ok := summary["scanned"].(int); !ok {
			hygieneShapeOk = false
		}
		for _, key := range []string{"lowValue", "stale", "duplicateClusters", "contradictionCandidates", "orphanCandidates"} {
			if _, ok := hygiene[key].([]map[string]any); !ok {
				hygieneShapeOk = false
			}
		}
	}
	packLen := func(key string) int {
		arr, _ := contextPack[key].([]SearchResultItem)
		return len(arr)
	}
	if suite == "" {
		suite = "core"
	}
	cases := []map[string]any{
		{"name": "newer fact supersedes older fact",
			"passed": LooksContradictory("NovaMem deployment uses port 7778", "NovaMem deployment uses port 7779")},
		{"name": "context pack groups typed memories",
			"passed": packLen("userPreferences") == 1 && packLen("decisions") == 1 && packLen("currentSetup") == 1},
		{"name": "junk capture is rejected", "passed": ShouldReject("ok") != ""},
		{"name": "hygiene report exposes review candidates", "passed": hygieneShapeOk},
		{"name": "memory-type retention policies are available",
			"passed": RetentionPolicyFor("deployment_state")["policy"] == "current_only"},
	}
	passed := 0
	for _, c := range cases {
		if ok, _ := c["passed"].(bool); ok {
			passed++
		}
	}
	return map[string]any{
		"suite":   suite,
		"passed":  passed == len(cases),
		"summary": map[string]any{"total": len(cases), "passed": passed, "failed": len(cases) - passed},
		"cases":   cases,
		"checks":  cases,
		"hygiene": hygiene,
	}, nil
}

func projectEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
