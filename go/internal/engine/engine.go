// Package engine is the data-plane core: remember/capture/recent/forget/
// update/stats. Transcribed from packages/server/src/engine/index.ts
// (read-only reference, never imported). Slice 2 scope: no cold store,
// no embedder, no graph — the embedding/enrichment side-effects of the
// TS write path collapse to their "embedder down" branches, which are
// themselves part of the TS contract (rows store with embedded_at NULL
// and the reconciler owns the backfill).
package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// HTTPError carries a status the HTTP layer forwards as {error: msg} —
// the same shape as a Fastify HttpError with a 4xx statusCode.
type HTTPError struct {
	StatusCode int
	Message    string
}

func (e *HTTPError) Error() string { return e.Message }

type Quotas struct {
	MaxEntries      int // 0 = unlimited
	WritesPerMinute int // 0 = unlimited
}

type Engine struct {
	warm            *warmstore.Store
	log             *slog.Logger
	quotas          Quotas
	maxContentChars int // NOVAMEM_MAX_CONTENT_CHARS; 0 disables
	personalTerms   []string
	startedAt       time.Time
	// Injectable seams for the DB-free quota-window unit tests; defaulted
	// to the warm store's methods in New.
	now          func() time.Time
	getUserQuota func(ctx context.Context, userID string) (maxEntries, writesPerMinute *int, err error)
	countEntries func(ctx context.Context, userID string) (int, error)

	// Per-user write-quota state — fixed 60s rate window + 30s-cached
	// entry count, per replica by design (engine/index.ts quotaState).
	quotaMu    sync.Mutex
	quotaState map[string]*quotaEntry
}

type quotaEntry struct {
	windowStart    time.Time
	writes         int
	countCheckedAt time.Time
	count          int
}

func New(warm *warmstore.Store, log *slog.Logger, quotas Quotas, maxContentChars int, personalTerms []string) *Engine {
	return &Engine{
		warm:            warm,
		log:             log,
		quotas:          quotas,
		maxContentChars: maxContentChars,
		personalTerms:   personalTerms,
		startedAt:       time.Now(),
		now:             time.Now,
		getUserQuota:    warm.GetUserQuota,
		countEntries:    warm.CountEntriesForUser,
		quotaState:      map[string]*quotaEntry{},
	}
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// RememberRequest mirrors the TS RememberRequest fields slice 2 serves.
type RememberRequest struct {
	Content      string
	Namespace    string // "" → "default"
	Source       string // "" → "manual"
	AgentName    *string
	Project      *string // resolved project ULID or nil
	Metadata     map[string]any
	Sensitivity  string
	SourceType   *string
	CapturedFrom *string
	Confidence   *float64
	Force        bool
	ExpiresAt    string // ISO-8601 or ""
}

type RememberResult struct {
	ID           *string  `json:"id"`
	Rejected     string   `json:"rejected,omitempty"`
	Deduplicated bool     `json:"deduplicated,omitempty"`
	Updated      bool     `json:"updated,omitempty"`
	Superseded   []string `json:"superseded,omitempty"`
	Embedded     *bool    `json:"embedded,omitempty"`
}

func boolPtr(b bool) *bool { return &b }

// withSensitivityMetadata — TTL rides in metadata.expiresAt and the
// inferred sensitivity is stamped in (engine/index.ts).
func withSensitivityMetadata(req RememberRequest) RememberRequest {
	sensitivity := InferSensitivity(req.Content, req.Metadata, req.Sensitivity)
	merged := map[string]any{}
	for k, v := range req.Metadata {
		merged[k] = v
	}
	if req.ExpiresAt != "" {
		merged["expiresAt"] = req.ExpiresAt
	}
	merged["sensitivity"] = sensitivity
	req.Metadata = merged
	return req
}

// Remember — engine/index.ts remember(), minus the embed/cold-upsert/
// enrichment/fact-extraction side-effects (slice 3+). Order preserved:
// quota first (force must not bypass it), then the worthiness gate,
// then the length check (applies even under force), then dedup, then
// the insert, then the changelog append.
func (e *Engine) Remember(ctx context.Context, userID string, req RememberRequest) (RememberResult, error) {
	if err := e.enforceWriteQuota(ctx, userID); err != nil {
		return RememberResult{}, err
	}
	if !req.Force {
		if reason := ShouldReject(req.Content); reason != "" {
			return RememberResult{Rejected: reason}, nil
		}
	}
	if reason := ContentTooLong(req.Content, e.maxContentChars); reason != "" {
		return RememberResult{Rejected: reason}, nil
	}
	req = withSensitivityMetadata(req)
	namespace := req.Namespace
	if namespace == "" {
		namespace = "default"
	}
	contentHash := sha256Hex(strings.TrimSpace(req.Content))

	// Exact-duplicate fast-path: return the existing id, bump hits.
	// slice 3: the TS server also self-heals a missing vector here
	// (backfillMissingVector); no cold store yet, so nothing to heal.
	existingID, _, found, err := e.warm.FindByContentHash(ctx, userID, req.Project, contentHash)
	if err != nil {
		return RememberResult{}, err
	}
	if found {
		if err := e.warm.BumpHits(ctx, existingID); err != nil {
			return RememberResult{}, err
		}
		embedded, err := e.warm.IsEmbedded(ctx, existingID)
		if err != nil {
			return RememberResult{}, err
		}
		return RememberResult{ID: &existingID, Deduplicated: true, Embedded: boolPtr(embedded)}, nil
	}

	source := req.Source
	if source == "" {
		source = "manual"
	}
	// graph_pending_at is set like the TS server does with its default
	// graphLinkFanout=3: the row owes vector-neighbour edges, and the
	// marker is what lets the (slice 3/6) reconciler pay the debt later.
	now := e.now()
	id, err := e.warm.InsertEntry(ctx, NewULID(), warmstore.InsertEntryArgs{
		UserID:         userID,
		ProjectID:      req.Project,
		Content:        req.Content,
		Namespace:      namespace,
		Source:         source,
		AgentName:      req.AgentName,
		Metadata:       req.Metadata,
		SourceType:     req.SourceType,
		CapturedFrom:   req.CapturedFrom,
		Confidence:     req.Confidence,
		ContentHash:    &contentHash,
		GraphPendingAt: &now,
	})
	if err != nil {
		return RememberResult{}, err
	}
	// slice 3: embed + cold upsert + set embedded_at happen here in TS.
	// With no embedder the row stays embedded_at NULL (the queue) and the
	// response reports embedded:false, exactly like TS with a down embedder.
	e.logChange(ctx, userID, req.Project, id, "created", map[string]any{"source": source})
	return RememberResult{ID: &id, Embedded: boolPtr(false)}, nil
}

// Capture — engine/index.ts capture()/captureInner(). With no embedder
// the semantic near-duplicate probe cannot run (TS falls through to a
// plain remember on an embed failure — same net behaviour), so capture
// is: gate checks, then remember with capture-derived metadata.
// slice 3: the contradiction/supersede and content-superset-update
// branches return once the cold store + embedder exist.
func (e *Engine) Capture(ctx context.Context, userID string, req RememberRequest) (RememberResult, error) {
	req = withSensitivityMetadata(req)
	if !req.Force {
		if reason := ShouldReject(req.Content); reason != "" {
			return RememberResult{Rejected: reason}, nil
		}
	}
	if reason := ContentTooLong(req.Content, e.maxContentChars); reason != "" {
		return RememberResult{Rejected: reason}, nil
	}
	namespace := req.Namespace
	if namespace == "" {
		namespace = "default"
	}
	req.Namespace = namespace
	req.Metadata = captureMetadata(req, "inserted", e.personalTerms)
	return e.Remember(ctx, userID, req)
}

// SearchResultItem is a /v1/recent results element — a map so the HTTP
// layer's contentMode shaping can delete keys exactly like the TS
// shapeContent helper does.
type SearchResultItem = map[string]any

type RecentArgs struct {
	Namespace         string
	K                 int
	Since             string // ISO-8601 or ""
	Project           *string
	IncludeProjects   []string
	IncludeNamespaces []string
	MaxSensitivity    string
}

// Recent — engine/index.ts recent(): namespace fanout resolution, then
// listRecent, then Go-side inactive + sensitivity filtering. `signals`
// is intentionally omitted (recent is ordered, not ranked).
func (e *Engine) Recent(ctx context.Context, userID string, args RecentArgs) ([]SearchResultItem, error) {
	var namespaces []string
	switch {
	case len(args.IncludeNamespaces) > 0:
		namespaces = args.IncludeNamespaces
	case args.Namespace != "":
		namespaces = []string{args.Namespace}
	default:
		ns, err := e.warm.ListNamespaces(ctx, userID, args.Project, args.IncludeProjects)
		if err != nil {
			return nil, err
		}
		if len(ns) == 0 {
			ns = []string{"default"}
		}
		namespaces = ns
	}
	k := args.K
	if k == 0 {
		k = 20
	}
	var since *time.Time
	if args.Since != "" {
		t, err := parseJSDate(args.Since)
		if err != nil {
			// Schema validation admits only ISO-8601; unreachable in practice.
			return nil, &HTTPError{StatusCode: 400, Message: "invalid since"}
		}
		since = &t
	}
	rows, err := e.warm.ListRecent(ctx, userID, namespaces, k, args.Project, args.IncludeProjects, since)
	if err != nil {
		return nil, err
	}
	results := []SearchResultItem{}
	for _, r := range rows {
		if isInactiveMemory(r.Metadata) {
			continue
		}
		if !isSensitivityVisible(r.Metadata, args.MaxSensitivity) {
			continue
		}
		tier := "warm"
		if r.Cold {
			tier = "cold"
		}
		var project any // null for user-global
		if r.ProjectID != nil {
			project = *r.ProjectID
		}
		results = append(results, SearchResultItem{
			"id":        r.ID,
			"score":     1.0,
			"content":   r.Content,
			"tier":      tier,
			"namespace": r.Namespace,
			"project":   project,
			"source":    r.Source,
			"metadata":  r.Metadata,
		})
	}
	return results, nil
}

type ForgetResult struct {
	Deleted      bool `json:"deleted"`
	ColdDeleteOk bool `json:"coldDeleteOk"`
}

// Forget — engine/index.ts forget(): resolve in scope, then the
// four-delete transaction. Idempotent: missing/out-of-scope ids answer
// deleted:false. No cold store in slice 2 → coldDeleteOk is always true
// and nothing is parked in cold_orphans (see warmstore.DeleteEntry).
func (e *Engine) Forget(ctx context.Context, userID, id string, project *string) (ForgetResult, error) {
	entry, err := e.warm.GetEntry(ctx, userID, id, project)
	if err != nil {
		return ForgetResult{}, err
	}
	if entry == nil {
		return ForgetResult{Deleted: false, ColdDeleteOk: true}, nil
	}
	if err := e.warm.DeleteEntry(ctx, id, entry.ProjectID, userID); err != nil {
		return ForgetResult{}, err
	}
	e.logChange(ctx, userID, entry.ProjectID, id, "deleted", map[string]any{"coldDeleteOk": true})
	return ForgetResult{Deleted: true, ColdDeleteOk: true}, nil
}

type UpdateRequest struct {
	Content      *string
	Namespace    *string
	Metadata     map[string]any
	Sensitivity  string
	SourceType   *string
	CapturedFrom *string
	Confidence   *float64
	Project      *string
}

type UpdateResult struct {
	Updated          bool `json:"updated"`
	EmbeddingChanged bool `json:"embeddingChanged"`
}

// Update — engine/index.ts update(): in-place rewrite preserving
// created_at/hits/edges, with content-hash refresh when content moves.
func (e *Engine) Update(ctx context.Context, userID, id string, req UpdateRequest) (UpdateResult, error) {
	metadata := req.Metadata
	if req.Sensitivity != "" {
		metadata = map[string]any{}
		for k, v := range req.Metadata {
			metadata[k] = v
		}
		metadata["sensitivity"] = req.Sensitivity
	}
	var newHash *string
	if req.Content != nil {
		h := sha256Hex(strings.TrimSpace(*req.Content))
		newHash = &h
	}
	ok, err := e.warm.UpdateEntry(ctx, warmstore.UpdateEntryArgs{
		UserID:       userID,
		ID:           id,
		ProjectID:    req.Project,
		Content:      req.Content,
		Namespace:    req.Namespace,
		Metadata:     metadata,
		SourceType:   req.SourceType,
		CapturedFrom: req.CapturedFrom,
		Confidence:   req.Confidence,
		ContentHash:  newHash,
	})
	if err != nil || !ok {
		return UpdateResult{}, err
	}
	if req.Content != nil {
		// The content moved but no vector can be written yet (no embedder
		// until slice 3). Re-queue rather than leave a stale vector
		// claiming to describe text that no longer exists — the exact
		// branch TS takes when its embed call fails.
		if err := e.warm.SetEmbeddedAt(ctx, id, nil); err != nil {
			return UpdateResult{}, err
		}
	}
	if status, _ := req.Metadata["lifecycleStatus"].(string); status != "superseded" {
		e.logChange(ctx, userID, req.Project, id, "updated", map[string]any{
			"contentChanged": req.Content != nil,
		})
	}
	return UpdateResult{Updated: true, EmbeddingChanged: false}, nil
}

type Stats struct {
	ByNamespace map[string]*NamespaceStats `json:"byNamespace"`
	TotalWarm   int64                      `json:"totalWarm"`
	TotalCold   int64                      `json:"totalCold"`
	LastDecayAt *string                    `json:"lastDecayAt"`
	UptimeMs    int64                      `json:"uptimeMs"`
}

type NamespaceStats struct {
	Warm int64 `json:"warm"`
	Cold int64 `json:"cold"`
}

// GetStats — engine/index.ts stats().
func (e *Engine) GetStats(ctx context.Context, userID string) (Stats, error) {
	rows, lastDecay, err := e.warm.Stats(ctx, userID)
	if err != nil {
		return Stats{}, err
	}
	out := Stats{
		ByNamespace: map[string]*NamespaceStats{},
		UptimeMs:    time.Since(e.startedAt).Milliseconds(),
	}
	for _, r := range rows {
		slot := out.ByNamespace[r.Namespace]
		if slot == nil {
			slot = &NamespaceStats{}
			out.ByNamespace[r.Namespace] = slot
		}
		if r.Cold {
			slot.Cold += r.Count
			out.TotalCold += r.Count
		} else {
			slot.Warm += r.Count
			out.TotalWarm += r.Count
		}
	}
	if lastDecay != nil {
		iso := lastDecay.UTC().Format("2006-01-02T15:04:05.000Z")
		out.LastDecayAt = &iso
	}
	return out, nil
}

// enforceWriteQuota — engine/index.ts enforceWriteQuota. Approximate by
// design: fixed 60s window + 30s-cached entry count, per replica. The
// 429 message strings are contract.
func (e *Engine) enforceWriteQuota(ctx context.Context, userID string) error {
	defaults := e.quotas
	if defaults.MaxEntries == 0 && defaults.WritesPerMinute == 0 {
		return nil
	}
	overrideMax, overrideRate, err := e.getUserQuota(ctx, userID)
	if err != nil {
		return err
	}
	maxEntries := defaults.MaxEntries
	if overrideMax != nil {
		maxEntries = *overrideMax
	}
	writesPerMinute := defaults.WritesPerMinute
	if overrideRate != nil {
		writesPerMinute = *overrideRate
	}
	if maxEntries == 0 && writesPerMinute == 0 {
		return nil
	}

	now := e.now()
	e.quotaMu.Lock()
	defer e.quotaMu.Unlock()
	s := e.quotaState[userID]
	if s == nil || now.Sub(s.windowStart) >= time.Minute {
		s = &quotaEntry{windowStart: now}
		// Bound the map like TS: stale users drop out wholesale.
		if len(e.quotaState) >= 10_000 {
			e.quotaState = map[string]*quotaEntry{}
		}
		e.quotaState[userID] = s
	}
	if writesPerMinute > 0 && s.writes >= writesPerMinute {
		return &HTTPError{StatusCode: 429, Message: fmt.Sprintf(
			"write quota exceeded: %d writes/minute — retry after the window resets", writesPerMinute)}
	}
	if maxEntries > 0 {
		if now.Sub(s.countCheckedAt) >= 30*time.Second {
			// Count query under the mutex: acceptable at slice-2 load, and
			// it keeps the check-then-increment atomic. ponytail: move the
			// count outside the lock if quota-enabled write throughput
			// ever matters.
			n, err := e.countEntries(ctx, userID)
			if err != nil {
				return err
			}
			s.count = n
			s.countCheckedAt = now
		}
		if s.count >= maxEntries {
			return &HTTPError{StatusCode: 429, Message: fmt.Sprintf(
				"entry quota exceeded: %d stored entries — forget something first", maxEntries)}
		}
		s.count++
	}
	s.writes++
	return nil
}

// logChange — best-effort changelog append; never fails the mutation
// (engine/index.ts logChange).
func (e *Engine) logChange(ctx context.Context, userID string, projectID *string, entryID, change string, detail map[string]any) {
	err := e.warm.RecordChanges(ctx, []warmstore.ChangeRow{{
		UserID: userID, ProjectID: projectID, EntryID: entryID, Change: change, Detail: detail,
	}})
	if err != nil {
		e.log.Warn("changelog append failed (mutation unaffected)",
			"err", err, "entryId", entryID, "change", change)
	}
}
