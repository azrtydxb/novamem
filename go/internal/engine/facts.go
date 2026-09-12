// Write-time LLM fact extraction, its durable queue and the reconciler
// that drains it. Transcribed from packages/server/src/engine/index.ts
// (storeFactsForChunk, reconcilePendingFacts).
//
// Contract: a failed extraction NEVER fails the write. The chunk is
// already committed with facts_pending_at set, so a crash, a timeout or
// an unusable model response leaves the debt on the row and the
// reconciler retries it.
package engine

import (
	"context"
	"strings"
	"time"

	"github.com/azrtydxb/novamem/go/internal/coldstore"
	"github.com/azrtydxb/novamem/go/internal/embeddings"
	"github.com/azrtydxb/novamem/go/internal/llm"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// storeFactsArgs — the closure engine.remember captures before firing the
// extraction off the write path.
type storeFactsArgs struct {
	userID       string
	projectID    *string
	chunkID      string
	chunkContent string
	namespace    string
	sensitivity  string
	parentSource string
}

// scheduleFactExtraction — the fire-and-forget half of the write path.
// Never blocks the write; failures are logged and the marker survives.
func (e *Engine) scheduleFactExtraction(args storeFactsArgs) {
	if e.extractor == nil {
		return
	}
	go func() {
		// Detached from the request context on purpose: the HTTP response
		// is already on its way out. The budget is the extractor's own
		// timeout plus room for the embed + writes that follow it.
		ctx, cancel := context.WithTimeout(context.Background(),
			time.Duration(e.extractorTimeoutMs)*time.Millisecond+2*time.Minute)
		defer cancel()
		if err := e.storeFactsForChunk(ctx, args); err != nil {
			e.log.Warn("fact extraction failed (chunk persisted, no facts)",
				"chunkId", args.chunkID, "err", err)
		}
	}()
}

// storeFactsForChunk distils one chunk into fact rows. ADD-only: exact
// duplicates collapse on content hash, and semantic consolidation happens
// in the dream cycle (off the write path, in batch) rather than through a
// second per-fact LLM call here.
func (e *Engine) storeFactsForChunk(ctx context.Context, args storeFactsArgs) error {
	if e.extractFacts == nil {
		return nil
	}
	facts, err := e.extractFacts(ctx, args.chunkContent)
	if err != nil {
		return err
	}
	// The source may have moved underneath us. Extraction is an LLM call
	// plus an embed plus N inserts — seconds — and it runs detached from
	// the write, so an update can land in the middle of it. Everything
	// below asserts facts about `args.chunkContent`; if the row no longer
	// holds that text those assertions are about wording that no longer
	// exists, and Update has already deleted the derivatives they would
	// sit beside. Writing them now would resurrect the old content's
	// facts (#272).
	if stale, err := e.sourceMoved(ctx, args); err != nil {
		// Could not tell. Treat as fatal so the marker survives and the
		// reconciler retries, rather than guessing and writing.
		return err
	} else if stale {
		// Deliberately no SetFactsPendingAt(nil): the debt is NOT settled.
		// Clearing it here is the second half of the bug — it tells the
		// reconciler the chunk is done, so the stale facts persist and
		// the new text never gets extracted if its own run also failed.
		e.log.Info("discarding facts extracted from superseded content",
			"chunkId", args.chunkID, "facts", len(facts))
		return nil
	}
	if len(facts) == 0 {
		// A chunk with nothing durable in it is a COMPLETED extraction,
		// not a failed one — clear the debt or the reconciler would re-run
		// the LLM against it forever.
		return e.warm.SetFactsPendingAt(ctx, args.chunkID, nil)
	}
	if len(facts) > e.extractorMaxFacts {
		facts = facts[:e.extractorMaxFacts]
	}

	// One embed call for the whole chunk's facts. A failure is not fatal:
	// the facts store unembedded and the embedding reconciler picks them
	// up, exactly as it does for chunks.
	factTexts := make([]string, len(facts))
	for i, f := range facts {
		factTexts[i] = llm.FactToText(f)
	}
	factEmbeddings := make([][]float64, len(facts))
	if e.embedder != nil {
		embedded, err := e.embedder.Embed(ctx, factTexts, embeddings.KindDocument)
		if err != nil {
			e.log.Warn("batch-embedding facts failed (facts stored without vectors; reconciler will backfill)",
				"chunkId", args.chunkID, "err", err)
		} else {
			for i := range facts {
				if i < len(embedded) {
					factEmbeddings[i] = embedded[i]
				}
			}
		}
	}

	for i, fact := range facts {
		text := factTexts[i]
		// Each fact gets its own content hash so an identical fact ingested
		// from a different chunk collapses onto the existing row instead of
		// double-storing — the only dedup the write path performs.
		contentHash := sha256Hex(strings.TrimSpace(text))
		existingID, _, found, err := e.warm.FindByContentHash(ctx, args.userID, args.projectID, contentHash)
		if err != nil {
			return err
		}
		if found {
			if err := e.warm.BumpHits(ctx, existingID); err != nil {
				return err
			}
			continue
		}
		metadata := map[string]any{
			"fact": map[string]any{
				"type":        fact.Type,
				"subject":     fact.Subject,
				"predicate":   fact.Predicate,
				"object":      fact.Object,
				"occurred_at": occurredAtValue(fact.OccurredAt),
				"entities":    fact.Entities,
				"importance":  fact.Importance,
			},
			"source_chunk_id": args.chunkID,
		}
		if args.sensitivity != "" {
			metadata["sensitivity"] = args.sensitivity
		}
		sourceType := "fact"
		confidence := 1.0
		factID, err := e.warm.InsertEntry(ctx, NewULID(), warmstore.InsertEntryArgs{
			UserID:      args.userID,
			ProjectID:   args.projectID,
			Content:     text,
			Namespace:   args.namespace,
			Source:      args.parentSource,
			Metadata:    metadata,
			SourceType:  &sourceType,
			Confidence:  &confidence,
			ContentHash: &contentHash,
		})
		if err != nil {
			return err
		}
		embedding := factEmbeddings[i]
		if len(embedding) == 0 || e.cold == nil {
			continue
		}
		if err := e.cold.Upsert(ctx, coldstore.UpsertArgs{
			UserID:    args.userID,
			ProjectID: args.projectID,
			ID:        factID,
			Namespace: args.namespace,
			Embedding: embedding,
			Payload:   map[string]any{"source": args.parentSource, "agentName": nil},
		}); err != nil {
			e.log.Warn("cold.upsert for fact failed (warm row kept; embedding reconciler will retry)",
				"factId", factID, "chunkId", args.chunkID, "err", err)
			continue
		}
		// Stamped separately so a stamp failure is reported as what it is:
		// the vector is already durable, and an unstamped row just gets
		// redundantly re-embedded by the (idempotent) reconciler.
		stampedAt := e.now()
		if err := e.warm.SetEmbeddedAt(ctx, factID, &stampedAt); err != nil {
			e.log.Warn("embedded_at stamp for fact failed (vector stored; reconciler will re-stamp)",
				"factId", factID, "chunkId", args.chunkID, "err", err)
		}
	}

	// Extraction completed and every fact row is committed — settle the
	// debt. On any error above the marker survives and the reconciler
	// retries the chunk; a partial re-run is near-idempotent because each
	// fact dedups on its content hash.
	return e.warm.SetFactsPendingAt(ctx, args.chunkID, nil)
}

// occurredAtValue keeps the TS `fact.occurredAt ?? null` shape: a fact
// with no timestamp stores JSON null, not an empty string.
func occurredAtValue(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// ReconcilePendingFacts drains chunks whose extraction never completed
// (capped, failed, or died in a crash). Concurrent by design — the
// extractor's own semaphore meters the LLM concurrency exactly as it does
// for live writes.
func (e *Engine) ReconcilePendingFacts(ctx context.Context, batchSize int) (ReconcileResult, error) {
	out := ReconcileResult{}
	if e.extractor == nil {
		return out, nil
	}
	rows, err := e.warm.ListPendingFacts(ctx, batchSize)
	if err != nil {
		return out, err
	}
	out.Scanned = len(rows)
	results := make(chan error, len(rows))
	for _, row := range rows {
		go func(row warmstore.PendingFactEntry) {
			sensitivity, _ := row.Metadata["sensitivity"].(string)
			results <- e.storeFactsForChunk(ctx, storeFactsArgs{
				userID:       row.UserID,
				projectID:    row.ProjectID,
				chunkID:      row.ID,
				chunkContent: row.Content,
				namespace:    row.Namespace,
				sensitivity:  sensitivity,
				parentSource: row.Source,
			})
		}(row)
	}
	for range rows {
		if err := <-results; err != nil {
			out.Failed++
			e.log.Warn("fact-extraction reconcile failed (marker kept, will retry)", "err", err)
			continue
		}
		out.Done++
	}
	pending, err := e.warm.CountPendingFacts(ctx)
	if err != nil {
		return out, err
	}
	out.Pending = pending
	return out, nil
}

// deleteDerivedFacts removes the fact rows distilled from a source
// entry, warm and cold. Reports false when a cold vector survived, so
// the caller can surface the same partial-delete signal it already uses
// for the source's own vector.
//
// Best-effort by design: the source row is already gone or already
// rewritten by the time this runs, and failing the whole call because a
// derived vector lingered would turn a successful edit into an error.
func (e *Engine) deleteDerivedFacts(ctx context.Context, userID, sourceID string, projectID *string) bool {
	derived, err := e.warm.DeleteDerivedFacts(ctx, userID, sourceID, projectID)
	if err != nil {
		e.log.Warn("derived facts survived their source", "sourceId", sourceID, "err", err)
		return false
	}
	ok := true
	for _, d := range derived {
		if e.cold == nil {
			continue
		}
		if err := e.cold.Delete(ctx, userID, d.Namespace, d.ID, d.ProjectID); err != nil {
			ok = false
			e.log.Warn("derived fact's cold vector survived; queued for reaper",
				"factId", d.ID, "sourceId", sourceID, "err", err)
			if parkErr := e.warm.RecordColdOrphan(ctx, d.ID, userID, d.Namespace, d.ProjectID, err.Error()); parkErr != nil {
				e.log.Warn("could not park orphaned derived vector", "factId", d.ID, "err", parkErr)
			}
		}
	}
	if len(derived) > 0 {
		e.log.Info("removed derived facts with their source",
			"sourceId", sourceID, "count", len(derived))
	}
	return ok
}

// sourceMoved reports whether the chunk still holds the content this
// extraction was run against.
//
// Compared by content hash, which the row already stores and which is
// computed the same way on both write paths (sha256 of the trimmed
// content), so this is one indexed lookup rather than fetching and
// diffing the text.
//
// Two cases deliberately do NOT count as moved:
//
//   - the row has no hash at all, which is possible for rows written
//     before content hashing. There is nothing to compare, and stalling
//     extraction forever on those is worse than the race this guards.
//   - the row is gone. Its facts are about nothing, but there is also no
//     marker left to settle, and the delete path removes derivatives.
//     Reported as moved so nothing is written.
func (e *Engine) sourceMoved(ctx context.Context, args storeFactsArgs) (bool, error) {
	current, found, err := e.entryContentHash(ctx, args.chunkID)
	if err != nil {
		return false, err
	}
	if !found {
		return true, nil
	}
	if current == "" {
		return false, nil
	}
	return current != sha256Hex(strings.TrimSpace(args.chunkContent)), nil
}
