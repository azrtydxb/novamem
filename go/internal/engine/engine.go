// Package engine is the data-plane core: remember/capture/recent/forget/
// update/stats plus the search plane in search.go. Transcribed from
// packages/server/src/engine/index.ts (read-only reference, never
// imported).
//
// The three LLM-backed subsystems (fact extraction in facts.go, the
// observer in observer.go, query decomposition + coherence rerank in
// search.go) are wired here and are nil-gated: with their
// NOVAMEM_*_ENABLED switch off the engine takes exactly the branches TS
// takes with the corresponding module unset.
package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/azrtydxb/novamem/go/internal/coldstore"
	"github.com/azrtydxb/novamem/go/internal/embeddings"
	"github.com/azrtydxb/novamem/go/internal/llm"
	"github.com/azrtydxb/novamem/go/internal/metrics"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

const (
	// engine/index.ts CAPTURE_CANDIDATE_K / SEMANTIC_DUPLICATE_THRESHOLD.
	captureCandidateK          = 5
	semanticDuplicateThreshold = 0.92
	// engine/index.ts MAX_ENRICH_IN_FLIGHT — the write path's bound on
	// concurrent fire-and-forget enrichment.
	maxEnrichInFlight = 16
)

// isoMillis is the JS `toISOString()` layout, the format every timestamp
// crosses the wire in.
const isoMillis = "2006-01-02T15:04:05.000Z"

// errNoEmbedder — no embedder configured. Handled exactly like an
// embedder outage: the row stores with embedded_at NULL.
var errNoEmbedder = errors.New("no embedder configured")

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
	warm     *warmstore.Store
	cold     *coldstore.Store   // nil when no cold tier is configured
	embedder *embeddings.Client // nil when no embedder is configured
	reranker *embeddings.Reranker
	// The three LLM subsystems; each is nil when its NOVAMEM_*_ENABLED
	// switch is off, and every call site nil-checks exactly where TS
	// checks its optional module.
	extractor          *llm.FactExtractor
	extractorMaxFacts  int
	extractorTimeoutMs int
	decomposer         *llm.QueryDecomposer
	observer           *llm.Observer
	log                *slog.Logger
	quotas             Quotas
	maxContentChars    int // NOVAMEM_MAX_CONTENT_CHARS; 0 disables
	personalTerms      []string
	minVectorScore     float64
	rerankPoolMult     int
	graphLinkFanout    int // 0 disables graph enrichment entirely
	// defaultEffectiveDays is the decay lifespan base (config.ts
	// decay.defaultEffectiveDays, 7).
	defaultEffectiveDays float64
	metrics              *metrics.Collector // nil when metrics are unwired
	startedAt            time.Time

	// promotedSinceLastDecay is the cold→warm promotion count the next
	// decay run reports and resets (engine/index.ts
	// promotedSinceLastDecay).
	promotedSinceLastDecay atomic.Int64
	// pendingEmbeddings is the backlog as of the last reconciler tick;
	// -1 before the first (health() reports null then).
	pendingEmbeddings atomic.Int64

	// Embedder-failure accounting (engine/index.ts recordEmbedFailure):
	// one ERROR per minute at most, with the suppressed count riding
	// along so a dead embeddings host can't turn a search incident into
	// a log-volume incident.
	embedMu                sync.Mutex
	lastEmbedErrorLoggedAt time.Time
	lastEmbedOkAt          time.Time
	lastEmbedErrorAt       time.Time
	suppressedEmbedErrors  int

	// In-flight fire-and-forget enrichment tasks (MAX_ENRICH_IN_FLIGHT).
	enrichInFlight atomic.Int64
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

// Options — everything the engine is composed of (engine/index.ts
// EngineConfig). Cold/Embedder/Reranker may be nil: the engine then
// takes the same branches TS takes with those services unreachable.
type Options struct {
	Warm     *warmstore.Store
	Cold     *coldstore.Store
	Embedder *embeddings.Client
	Reranker *embeddings.Reranker
	// Extractor / Decomposer / Observer — nil disables the corresponding
	// feature, which is exactly TS's behaviour with the module unset.
	Extractor *llm.FactExtractor
	// ExtractorMaxFacts — extraction.maxFactsPerChunk, re-applied at the
	// call site as TS does; 0 → 8 (config.ts default).
	ExtractorMaxFacts int
	// ExtractorTimeoutMs sizes the detached context of the fire-and-forget
	// write-path extraction; 0 → 120000 (config.ts default).
	ExtractorTimeoutMs int
	Decomposer         *llm.QueryDecomposer
	Observer           *llm.Observer
	Log                *slog.Logger

	Quotas          Quotas
	MaxContentChars int
	PersonalTerms   []string
	// MinVectorScore is the fusion noise floor; an explicit 0 disables it
	// (config supplies the 0.25 default).
	MinVectorScore float64
	// RerankPoolMult — rerank.poolMultiplier; 0 → 4 (config.ts default).
	RerankPoolMult int
	// GraphLinkFanout — co_occurs edges per write; 0 disables enrichment.
	GraphLinkFanout int
	// DefaultEffectiveDays — decay lifespan base; 0 → 7 (config default).
	DefaultEffectiveDays float64
	// Metrics may be nil (unit tests); every call site nil-checks.
	Metrics *metrics.Collector
}

func New(o Options) *Engine {
	if o.RerankPoolMult == 0 {
		o.RerankPoolMult = 4
	}
	if o.DefaultEffectiveDays == 0 {
		o.DefaultEffectiveDays = 7
	}
	if o.ExtractorMaxFacts == 0 {
		o.ExtractorMaxFacts = 8
	}
	if o.ExtractorTimeoutMs == 0 {
		o.ExtractorTimeoutMs = 120_000
	}
	e := &Engine{
		warm:               o.Warm,
		cold:               o.Cold,
		embedder:           o.Embedder,
		reranker:           o.Reranker,
		extractor:          o.Extractor,
		extractorMaxFacts:  o.ExtractorMaxFacts,
		extractorTimeoutMs: o.ExtractorTimeoutMs,
		decomposer:         o.Decomposer,
		observer:           o.Observer,
		log:                o.Log,
		quotas:             o.Quotas,
		maxContentChars:    o.MaxContentChars,
		personalTerms:      o.PersonalTerms,
		minVectorScore:     o.MinVectorScore,
		rerankPoolMult:     o.RerankPoolMult,
		graphLinkFanout:    o.GraphLinkFanout,

		defaultEffectiveDays: o.DefaultEffectiveDays,
		metrics:              o.Metrics,
		startedAt:            time.Now(),
		now:                  time.Now,
		getUserQuota:         o.Warm.GetUserQuota,
		countEntries:         o.Warm.CountEntriesForUser,
		quotaState:           map[string]*quotaEntry{},
	}
	e.pendingEmbeddings.Store(-1)
	return e
}

// recordEmbedFailure — engine/index.ts recordEmbedFailure. ERROR level
// (this is data becoming unfindable, not a degraded nicety), throttled
// to once a minute.
func (e *Engine) recordEmbedFailure(err error, op, entryID string) {
	e.embedMu.Lock()
	now := e.now()
	e.lastEmbedErrorAt = now
	if now.Sub(e.lastEmbedErrorLoggedAt) < time.Minute {
		e.suppressedEmbedErrors++
		e.embedMu.Unlock()
		return
	}
	suppressed := e.suppressedEmbedErrors
	e.suppressedEmbedErrors = 0
	e.lastEmbedErrorLoggedAt = now
	e.embedMu.Unlock()
	e.log.Error("embedder failed — entry stored without a vector and is not findable "+
		"by semantic search until the reconciler drains it",
		"op", op, "entryId", entryID, "err", err, "suppressedSinceLastLog", suppressed)
}

// embedderFailing — "failing" only when the most recent outcome was a
// failure; a blip that later succeeded is not an outage.
func (e *Engine) embedderFailing() bool {
	e.embedMu.Lock()
	defer e.embedMu.Unlock()
	return !e.lastEmbedErrorAt.IsZero() && e.lastEmbedErrorAt.After(e.lastEmbedOkAt)
}

func (e *Engine) recordEmbedSuccess() {
	e.embedMu.Lock()
	e.lastEmbedOkAt = e.now()
	e.embedMu.Unlock()
}

// embedDocument — the "document" side of the asymmetric prefix pair.
// Returns errNoEmbedder when nothing is configured so every caller takes
// its embedder-down branch rather than special-casing nil.
func (e *Engine) embedDocument(ctx context.Context, content string) ([]float64, error) {
	if e.embedder == nil {
		return nil, errNoEmbedder
	}
	vecs, err := e.embedder.Embed(ctx, []string{content}, embeddings.KindDocument)
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 {
		return nil, nil
	}
	return vecs[0], nil
}

// vectorTierReady — an embedding is only useful if there is somewhere to
// put it.
func (e *Engine) vectorTierReady() bool { return e.embedder != nil && e.cold != nil }

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

// Remember — engine/index.ts remember(). Order preserved: quota first
// (force must not bypass it), then the worthiness gate, then the length
// check (applies even under force), then dedup, then the insert, then
// embed + cold upsert + enrichment, then the changelog append.
func (e *Engine) Remember(ctx context.Context, userID string, req RememberRequest) (RememberResult, error) {
	return e.remember(ctx, userID, req, nil)
}

// remember takes an optional pre-computed embedding: capture() already
// embedded the content to find near-duplicates, and passing it through
// halves the embedder calls on the agent-facing write path.
func (e *Engine) remember(ctx context.Context, userID string, req RememberRequest, precomputed []float64) (RememberResult, error) {
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

	// Exact-duplicate fast-path: return the existing id, bump hits, and
	// self-heal a missing vector — the insert side's repair path, the
	// twin of the delete side's cold_orphans queue.
	existingID, existingNamespace, found, err := e.warm.FindByContentHash(ctx, userID, req.Project, contentHash)
	if err != nil {
		return RememberResult{}, err
	}
	if found {
		if err := e.warm.BumpHits(ctx, existingID); err != nil {
			return RememberResult{}, err
		}
		// Repaired in the namespace the entry actually lives in: dedup
		// matches on (user, project, hash) with namespace excluded, and
		// using the request's namespace indexed the vector under a shelf
		// the entry was never written to (a cross-shelf leak).
		e.backfillMissingVector(ctx, userID, req.Project, existingID, existingNamespace, req)
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
	// graph_pending_at is written in the same statement as the row: this
	// entry owes vector-neighbour edges, and the debt must survive a
	// crash in the window between INSERT and the async attempt below.
	var graphPendingAt *time.Time
	if e.graphLinkFanout > 0 {
		now := e.now()
		graphPendingAt = &now
	}
	// Same in-transaction debt rule: this chunk owes a fact-extraction
	// pass, and the marker must survive a crash in the window between
	// INSERT and the fire-and-forget schedule below. Without it a pod
	// restart mid-drain silently lost the facts of every in-flight chunk.
	var factsPendingAt *time.Time
	if e.extractor != nil {
		now := e.now()
		factsPendingAt = &now
	}
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
		FactsPendingAt: factsPendingAt,
		GraphPendingAt: graphPendingAt,
	})
	if err != nil {
		return RememberResult{}, err
	}

	// The row is already committed. If the embedder is unreachable we
	// keep it that way and leave embedded_at NULL: losing the memory
	// outright is a worse failure than a memory that is temporarily
	// findable by keyword and graph only, and the NULL is what lets the
	// reconciler finish the job later.
	embedding := precomputed
	embedderDown := false
	if embedding == nil {
		if !e.vectorTierReady() {
			embedderDown = true
		} else if vec, err := e.embedDocument(ctx, req.Content); err != nil {
			embedderDown = true
			e.recordEmbedFailure(err, "remember", id)
		} else {
			embedding = vec
			e.recordEmbedSuccess()
		}
	}

	embedded := false
	switch {
	case len(embedding) > 0 && e.cold != nil:
		// If the vector write fails the warm row is already committed.
		// Park it so the reaper can finish the job instead of leaving a
		// memory keyword search can find and vector search cannot.
		if err := e.cold.Upsert(ctx, coldstore.UpsertArgs{
			UserID:    userID,
			ProjectID: req.Project,
			ID:        id,
			Namespace: namespace,
			Embedding: embedding,
			Payload:   e.vectorPayload(source, req.AgentName),
		}); err != nil {
			e.parkMissingVector(ctx, userID, req.Project, id, namespace, err)
			return RememberResult{}, err
		}
		// Stamped only after the vector is durably in the cold store: the
		// marker means "a vector exists", so ordering it after the upsert
		// is what keeps it from lying when cold is the tier that failed.
		stampedAt := e.now()
		if err := e.warm.SetEmbeddedAt(ctx, id, &stampedAt); err != nil {
			return RememberResult{}, err
		}
		embedded = true
		e.scheduleEnrichment(userID, req.Project, id, namespace, embedding)
	case !embedderDown:
		// The embedder answered but handed back nothing — a bad response,
		// not an outage, so the reaper's repair queue is the right owner.
		// A genuine outage is deliberately NOT parked: every write during
		// a multi-day failure would enqueue an orphan and the reaper would
		// burn its bounded attempt budget against a dead host. The NULL
		// embedded_at left on the row is the outage queue.
		e.parkMissingVector(ctx, userID, req.Project, id, namespace,
			errors.New("embedder returned no vector"))
	}

	// Schedule LLM fact extraction in the background. Fire-and-forget —
	// never blocks the write; errors are logged only.
	// The EXPLICIT request field, not the inferred metadata value: TS
	// captures `req.sensitivity` here, so a fact only carries a
	// sensitivity stamp when the caller asked for one.
	e.scheduleFactExtraction(storeFactsArgs{
		userID:       userID,
		projectID:    req.Project,
		chunkID:      id,
		chunkContent: req.Content,
		namespace:    namespace,
		sensitivity:  req.Sensitivity,
		parentSource: source,
	})

	e.logChange(ctx, userID, req.Project, id, "created", map[string]any{"source": source})
	return RememberResult{ID: &id, Embedded: boolPtr(embedded)}, nil
}

// vectorPayload — the cold-store point payload the TS server writes.
func (e *Engine) vectorPayload(source string, agentName *string) map[string]any {
	payload := map[string]any{"source": source, "agentName": agentName}
	if e.embedder != nil {
		payload["embeddingModel"] = e.embedder.ModelID()
	}
	return payload
}

// parkMissingVector — engine/index.ts parkMissingVector: queue a warm row
// whose vector never landed. A failure to park is itself only logged;
// the write has already succeeded.
func (e *Engine) parkMissingVector(ctx context.Context, userID string, projectID *string, id, namespace string, cause error) {
	if err := e.warm.RecordMissingVector(ctx, userID, projectID, id, namespace); err != nil {
		e.log.Error("cold upsert failed AND could not park entry for backfill",
			"entryId", id, "namespace", namespace, "err", err)
		return
	}
	e.log.Warn("cold upsert failed — parked for vector backfill",
		"entryId", id, "namespace", namespace, "err", cause)
}

// backfillMissingVector — repair path for the dedup fast-path: verify the
// existing entry still has a vector and re-embed if not. Failures are
// logged, never fatal — a dedup hit must stay a success.
func (e *Engine) backfillMissingVector(ctx context.Context, userID string, projectID *string, id, namespace string, req RememberRequest) {
	if !e.vectorTierReady() {
		return
	}
	fail := func(err error) {
		e.log.Warn("vector backfill on dedup hit failed",
			"entryId", id, "namespace", namespace, "err", err)
	}
	present, err := e.cold.ExistingIds(ctx, []coldstore.EntryRef{
		{ID: id, UserID: userID, ProjectID: projectID, Namespace: namespace},
	})
	if err != nil {
		fail(err)
		return
	}
	if present[id] {
		return
	}
	embedding, err := e.embedDocument(ctx, req.Content)
	if err != nil {
		fail(err)
		return
	}
	if len(embedding) == 0 {
		return
	}
	source := req.Source
	if source == "" {
		source = "manual"
	}
	if err := e.cold.Upsert(ctx, coldstore.UpsertArgs{
		UserID:    userID,
		ProjectID: projectID,
		ID:        id,
		Namespace: namespace,
		Embedding: embedding,
		Payload:   e.vectorPayload(source, req.AgentName),
	}); err != nil {
		fail(err)
		return
	}
	if err := e.warm.ClearMissingVector(ctx, id); err != nil {
		fail(err)
		return
	}
	e.log.Info("backfilled missing cold vector on dedup hit", "entryId", id, "namespace", namespace)
}

// scheduleEnrichment — capped fire-and-forget graph enrichment. A write's
// contract is "insert + queue the enrichment debts": awaiting the
// neighbour search here put every concurrent writer in one queue and was
// the measured write-path ceiling. Over the cap the work is deferred, not
// lost — graph_pending_at is already set, so the reconciler drains it.
func (e *Engine) scheduleEnrichment(userID string, projectID *string, id, namespace string, embedding []float64) {
	if e.graphLinkFanout <= 0 || e.cold == nil {
		return
	}
	if e.enrichInFlight.Load() >= maxEnrichInFlight {
		e.log.Warn("graph enrichment saturated — deferred to the reconciler (marker kept)",
			"entryId", id, "inFlight", e.enrichInFlight.Load())
		return
	}
	e.enrichInFlight.Add(1)
	go func() {
		defer e.enrichInFlight.Add(-1)
		// Detached from the request context on purpose: the HTTP response
		// is already on its way out.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := e.enrichEntry(ctx, userID, projectID, id, namespace, embedding); err != nil {
			e.log.Warn("async graph enrichment failed (marker kept, reconciler will retry)",
				"entryId", id, "err", err)
		}
	}()
}

// enrichEntry — vector-neighbour co_occurs edges, then clear the debt
// marker. Returns the first error without clearing the marker: clearing
// it on a partial write is how edges get silently lost.
func (e *Engine) enrichEntry(ctx context.Context, userID string, projectID *string, id, namespace string, embedding []float64) error {
	hits, err := e.cold.Search(ctx, coldstore.SearchArgs{
		UserID:    userID,
		ProjectID: projectID,
		Namespace: namespace,
		Embedding: embedding,
		K:         e.graphLinkFanout + 1, // +1 because the entry itself is a hit
	})
	if err != nil {
		return err
	}
	linked := 0
	for _, h := range hits {
		if h.ID == id || linked >= e.graphLinkFanout {
			continue
		}
		if err := e.warm.AddRelation(ctx, userID, id, h.ID, "co_occurs", h.Score, projectID); err != nil {
			return err
		}
		linked++
	}
	return e.warm.SetGraphPendingAt(ctx, id, nil)
}

// Capture — engine/index.ts capture()/captureInner(). Capture is remember
// plus one thing: the near-duplicate guard below. Every outcome's
// *handling* (rejection wording, dedup fast-path with its backfill
// self-heal) lives in remember() alone — the TS code cloned it once and
// the clones drifted.
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

	// This embed only powers the near-duplicate lookup, and unlike
	// remember() it runs before anything is written. An unguarded failure
	// would drop the caller's memory on the floor for the duration of an
	// embedder outage — the one outcome worse than storing it unembedded.
	// On failure we skip dedup and fall through to the plain insert; the
	// cost is a possible duplicate row.
	var embedding []float64
	if e.vectorTierReady() {
		if vec, err := e.embedDocument(ctx, req.Content); err != nil {
			e.recordEmbedFailure(err, "capture.dedup-probe", "")
		} else {
			embedding = vec
			e.recordEmbedSuccess()
		}
	}

	if len(embedding) > 0 {
		candidate, err := e.nearDuplicate(ctx, userID, req.Project, namespace, embedding)
		if err != nil {
			return RememberResult{}, err
		}
		if candidate != nil {
			if LooksContradictory(candidate.Content, req.Content) {
				return e.supersedeWithNewFact(ctx, userID, candidate, req, namespace, embedding)
			}
			// Overwrite guard: a high cosine alone does NOT mean "same
			// fact restated". "wife's birthday is May 3" and "daughter's
			// birthday is May 3" clear 0.92 with identical scalars.
			// IsContentSuperset only permits the overwrite when the new
			// text keeps every content word the old one had.
			if IsContentSuperset(candidate.Content, req.Content) {
				updated, err := e.Update(ctx, userID, candidate.ID, UpdateRequest{
					Content:      &req.Content,
					Namespace:    &namespace,
					Metadata:     e.supersetMetadata(candidate, req, namespace),
					SourceType:   orDefault(req.SourceType, "chat"),
					CapturedFrom: orDefault(req.CapturedFrom, "memory_capture"),
					Confidence:   req.Confidence,
					Project:      req.Project,
				})
				if err != nil {
					return RememberResult{}, err
				}
				if updated.Updated {
					// embeddingChanged is false when the re-embed failed, so
					// the caller is told the row is stored but not yet
					// searchable.
					return RememberResult{
						ID:           &candidate.ID,
						Deduplicated: true,
						Updated:      true,
						Embedded:     boolPtr(updated.EmbeddingChanged),
					}, nil
				}
			}
		}
	}

	req.Metadata = captureMetadata(req, "inserted", e.personalTerms)
	return e.remember(ctx, userID, req, embedding)
}

func orDefault(v *string, fallback string) *string {
	if v != nil {
		return v
	}
	return &fallback
}

// nearDuplicate — the semantic probe: the closest active entry in scope
// at or above the 0.92 duplicate threshold, or nil.
func (e *Engine) nearDuplicate(ctx context.Context, userID string, projectID *string, namespace string, embedding []float64) (*warmstore.Entry, error) {
	nearby, err := e.cold.Search(ctx, coldstore.SearchArgs{
		UserID:    userID,
		ProjectID: projectID,
		Namespace: namespace,
		Embedding: embedding,
		K:         captureCandidateK,
	})
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, h := range nearby {
		if h.Score >= semanticDuplicateThreshold {
			ids = append(ids, h.ID)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	entries, err := e.warm.GetEntries(ctx, userID, ids, projectID, nil)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry != nil && !isInactiveMemory(entry.Metadata) {
			return entry, nil
		}
	}
	return nil, nil
}

// supersetMetadata — mergeCaptureMetadata(candidate.metadata,
// req.metadata, {...}) for the in-place update branch: the candidate's
// metadata is the base, so fields it carried survive the overwrite.
func (e *Engine) supersetMetadata(candidate *warmstore.Entry, req RememberRequest, namespace string) map[string]any {
	merged := map[string]any{}
	for k, v := range candidate.Metadata {
		merged[k] = v
	}
	for k, v := range req.Metadata {
		merged[k] = v
	}
	memType := InferMemoryType(req.Content, namespace, req.Metadata)
	confidence := 1.0
	if req.Confidence != nil {
		confidence = *req.Confidence
	}
	merged["lifecycleStatus"] = "active"
	merged["memoryType"] = memType
	merged["worthiness"] = ScoreWorthiness(req.Content, memType, confidence, e.personalTerms)
	merged["retention"] = RetentionPolicyFor(memType)
	merged["captureAction"] = "updated"
	merged["updatedByCaptureAt"] = e.now().UTC().Format(isoMillis)
	return merged
}

// supersedeWithNewFact — store req as the new active fact and mark the
// candidate superseded. The two writes are not atomic, so the failure
// mode is handled explicitly: if marking the old fact fails, the
// just-created row is removed again. Without that compensation the store
// keeps TWO active contradictory facts, and a retry can't fix it because
// content-hash dedup short-circuits to the orphaned new row.
func (e *Engine) supersedeWithNewFact(ctx context.Context, userID string, candidate *warmstore.Entry, req RememberRequest, namespace string, embedding []float64) (RememberResult, error) {
	supersededAt := e.now().UTC().Format(isoMillis)
	newMetadata := captureMetadata(req, "superseded", e.personalTerms)
	newMetadata["supersedes"] = []string{candidate.ID}
	newMetadata["supersededAt"] = supersededAt

	newReq := req
	newReq.Namespace = namespace
	newReq.Metadata = newMetadata
	newReq.Force = true
	created, err := e.remember(ctx, userID, newReq, embedding)
	if err != nil {
		return RememberResult{}, err
	}
	if created.ID == nil {
		return created, nil
	}

	oldMetadata := map[string]any{}
	for k, v := range candidate.Metadata {
		oldMetadata[k] = v
	}
	oldMetadata["lifecycleStatus"] = "superseded"
	oldMetadata["supersededBy"] = *created.ID
	oldMetadata["supersededReason"] = "contradiction"
	oldMetadata["supersededAt"] = supersededAt
	updated, markErr := e.Update(ctx, userID, candidate.ID, UpdateRequest{
		Project:  req.Project,
		Metadata: oldMetadata,
	})
	if markErr == nil && !updated.Updated {
		markErr = fmt.Errorf("could not mark %s superseded", candidate.ID)
	}
	if markErr != nil {
		// Compensate: undo the new fact so the store never holds two
		// active contradictory memories, then surface the failure.
		if _, rollbackErr := e.Forget(ctx, userID, *created.ID, req.Project); rollbackErr != nil {
			e.log.Error("capture: supersede failed AND rollback of the new fact failed — "+
				"store now holds two active contradictory memories",
				"entryId", *created.ID, "err", rollbackErr)
		}
		return RememberResult{}, markErr
	}
	e.logChange(ctx, userID, req.Project, candidate.ID, "superseded",
		map[string]any{"supersededBy": *created.ID})
	embedded := created.Embedded != nil && *created.Embedded
	return RememberResult{ID: created.ID, Superseded: []string{candidate.ID}, Embedded: &embedded}, nil
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
// four-delete transaction, then the cold delete. Idempotent:
// missing/out-of-scope ids answer deleted:false. A surviving cold vector
// is parked in cold_orphans for the reaper rather than rounded up to
// success.
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
	coldDeleteOk := true
	if e.cold != nil {
		if delErr := e.cold.Delete(ctx, userID, entry.Namespace, id, entry.ProjectID); delErr != nil {
			// Warm row is already gone; the cold vector is orphaned. Park
			// the id; the reaper retries until the delete succeeds.
			coldDeleteOk = false
			e.log.Warn("forget: cold vector survived; queued for reaper", "entryId", id, "err", delErr)
			if parkErr := e.warm.RecordColdOrphan(ctx, id, userID, entry.Namespace, entry.ProjectID, delErr.Error()); parkErr != nil {
				return ForgetResult{}, parkErr
			}
		}
	}
	e.logChange(ctx, userID, entry.ProjectID, id, "deleted", map[string]any{"coldDeleteOk": coldDeleteOk})
	return ForgetResult{Deleted: true, ColdDeleteOk: coldDeleteOk}, nil
}

// DeleteProjectResult — engine/index.ts deleteProject's return shape.
// coldCollectionsDropped is the pgvector store's per-scope report.
type DeleteProjectResult struct {
	Deleted                bool     `json:"deleted"`
	EntriesRemoved         int      `json:"entriesRemoved"`
	ColdCollectionsDropped []string `json:"coldCollectionsDropped"`
	// GraphCleared is kept for wire compatibility: relations live in
	// memory_relations and go with the rows in the warm delete.
	GraphCleared bool `json:"graphCleared"`
}

// DeleteProject — engine/index.ts deleteProject: warm delete first, then
// best-effort cold cleanup (a cold failure is logged, not fatal — the
// project rows are already gone).
func (e *Engine) DeleteProject(ctx context.Context, projectID, ownerUserID string) (DeleteProjectResult, error) {
	deleted, entriesRemoved, err := e.warm.DeleteProject(ctx, projectID)
	if err != nil {
		return DeleteProjectResult{}, err
	}
	if !deleted {
		return DeleteProjectResult{ColdCollectionsDropped: []string{}}, nil
	}
	dropped := []string{}
	if e.cold != nil {
		if scopes, err := e.cold.DeleteAllForProject(ctx, projectID); err != nil {
			e.log.Warn("deleteProject: cold cleanup failed", "projectId", projectID, "err", err)
		} else {
			dropped = scopes
		}
	}
	return DeleteProjectResult{
		Deleted:                true,
		EntriesRemoved:         entriesRemoved,
		ColdCollectionsDropped: dropped,
		GraphCleared:           true,
	}, nil
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
	embeddingChanged := false
	if req.Content != nil {
		// Re-resolve the entry to learn its actual namespace (the caller
		// may have omitted it from the update body).
		entry, err := e.warm.GetEntry(ctx, userID, id, req.Project)
		if err != nil {
			return UpdateResult{}, err
		}
		if entry == nil {
			return UpdateResult{Updated: true}, nil
		}
		var embedding []float64
		if e.vectorTierReady() {
			if vec, err := e.embedDocument(ctx, *req.Content); err != nil {
				e.recordEmbedFailure(err, "update", id)
			} else {
				embedding = vec
				e.recordEmbedSuccess()
			}
		}
		if len(embedding) > 0 {
			if err := e.cold.Upsert(ctx, coldstore.UpsertArgs{
				UserID:    userID,
				ProjectID: entry.ProjectID,
				ID:        id,
				Namespace: entry.Namespace,
				Embedding: embedding,
				Payload:   map[string]any{"source": entry.Source, "agentName": entry.AgentName},
			}); err != nil {
				return UpdateResult{}, err
			}
			stampedAt := e.now()
			if err := e.warm.SetEmbeddedAt(ctx, id, &stampedAt); err != nil {
				return UpdateResult{}, err
			}
			embeddingChanged = true
		} else {
			// The content moved but the vector didn't. Re-queue rather than
			// leave the entry marked embedded: the stale vector now
			// describes text that no longer exists, so semantic search
			// would surface this entry for the OLD wording and miss it for
			// the new.
			if err := e.warm.SetEmbeddedAt(ctx, id, nil); err != nil {
				return UpdateResult{}, err
			}
		}
	}
	if status, _ := req.Metadata["lifecycleStatus"].(string); status != "superseded" {
		e.logChange(ctx, userID, req.Project, id, "updated", map[string]any{
			"contentChanged": req.Content != nil,
		})
	}
	return UpdateResult{Updated: true, EmbeddingChanged: embeddingChanged}, nil
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
