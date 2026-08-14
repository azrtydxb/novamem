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
	if e.extractor == nil {
		return nil
	}
	facts, err := e.extractor.Extract(ctx, args.chunkContent)
	if err != nil {
		return err
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
