// Dream cycle — periodic compaction, run daily by the background job and
// on demand via POST /v1/dream-cycle. Transcribed from
// packages/server/src/engine/index.ts dreamCycle():
//
//  1. Dedup-merge: walk entries from a persisted cursor, pull vector
//     neighbours, accept a pair as duplicate when cosine ≥ 0.97 AND
//     token-set Jaccard ≥ 0.5 (both required, so contradictions like
//     "lives in X" / "lives in Y" don't merge). Canonical = most hits,
//     oldest as tiebreak; hits are summed, edges redirected, the loser
//     deleted warm-side and cold-side.
//  2. Edge promotion: two memories sharing ≥3 graph neighbours get a
//     direct co_inferred edge so search picks up transitive links.
//
// The TS server has a phase 1.5 between them — LLM fact consolidation
// through the fact extractor. No extractor is ported to Go, so the
// `facts*` counters report 0 exactly as the TS server does with
// extraction disabled.
package engine

import (
	"context"
	"time"

	"github.com/azrtydxb/novamem/go/internal/coldstore"
)

const (
	dreamCursorKey     = "dream:cursor"
	dreamCosineMin     = 0.97
	dreamJaccardMin    = 0.5
	dreamEdgeMinCommon = 3
	dreamMaxEntries    = 5000
	dreamNeighbourK    = 4
)

// DreamCycleResult — POST /v1/dream-cycle's body.
type DreamCycleResult struct {
	Walked             int   `json:"walked"`
	Merged             int   `json:"merged"`
	EdgesPromoted      int   `json:"edgesPromoted"`
	FactsWalked        int   `json:"factsWalked"`
	FactClustersJudged int   `json:"factClustersJudged"`
	FactsSuperseded    int   `json:"factsSuperseded"`
	DurationMs         int64 `json:"durationMs"`
}

func (e *Engine) DreamCycle(ctx context.Context) (DreamCycleResult, error) {
	started := time.Now()
	out := DreamCycleResult{}
	if !e.vectorTierReady() {
		// Phase 1 needs vectors; phase 2 is pure SQL and still runs.
		promoted, err := e.promoteCommonNeighborEdges(ctx)
		out.EdgesPromoted = promoted
		out.DurationMs = time.Since(started).Milliseconds()
		return out, err
	}

	// Walk forward from where the last run stopped rather than always
	// re-reading the oldest slice: ids are ULIDs, so `id > cursor` is both
	// creation-ordered and an index range scan. Running out of rows wraps
	// the cursor, making coverage a continuous loop over the table.
	cursor, err := e.warm.GetEngineState(ctx, dreamCursorKey)
	if err != nil {
		e.log.Warn("dream: could not read cursor — starting from the top", "err", err)
	}
	rows, err := e.warm.Pool.Query(ctx, `
		SELECT id, user_id, project_id, namespace, content
		  FROM memory_entries WHERE id > $2 ORDER BY id ASC LIMIT $1`,
		dreamMaxEntries, cursor)
	if err != nil {
		return out, err
	}
	type walkRow struct {
		id, userID, namespace, content string
		projectID                      *string
	}
	var batch []walkRow
	for rows.Next() {
		var r walkRow
		if err := rows.Scan(&r.id, &r.userID, &r.projectID, &r.namespace, &r.content); err != nil {
			rows.Close()
			return out, err
		}
		batch = append(batch, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	// Advance (or wrap) BEFORE doing the work, so a mid-run failure can't
	// pin the cycle to the same slice forever.
	next := ""
	if len(batch) == dreamMaxEntries {
		next = batch[len(batch)-1].id
	}
	if err := e.warm.SetEngineState(ctx, dreamCursorKey, next); err != nil {
		e.log.Warn("could not persist dream-cycle cursor", "err", err)
	}

	mergedSet := map[string]bool{}
	for _, row := range batch {
		out.Walked++
		if mergedSet[row.id] {
			continue
		}
		embedding, err := e.embedDocument(ctx, row.content)
		if err != nil || len(embedding) == 0 {
			continue
		}
		hits, err := e.cold.Search(ctx, coldstore.SearchArgs{
			UserID: row.userID, ProjectID: row.projectID, Namespace: row.namespace,
			Embedding: embedding, K: dreamNeighbourK,
		})
		if err != nil {
			e.log.Warn("dream cold.search failed", "err", err)
			continue
		}
		for _, n := range hits {
			if n.ID == row.id || mergedSet[n.ID] || n.Score < dreamCosineMin {
				continue
			}
			other, err := e.warm.GetEntry(ctx, row.userID, n.ID, row.projectID)
			if err != nil || other == nil {
				continue
			}
			if jaccardOf(contentTokens(row.content), contentTokens(other.Content)) < dreamJaccardMin {
				continue
			}
			self, err := e.warm.GetEntry(ctx, row.userID, row.id, row.projectID)
			if err != nil || self == nil {
				continue
			}
			stats, err := e.warm.GetColdEntryStatsMany(ctx, []string{row.id, n.ID})
			if err != nil {
				continue
			}
			rowHits, otherHits := stats[row.id].Hits, stats[n.ID].Hits
			keepRow := rowHits > otherHits ||
				(rowHits == otherHits && self.CreatedAt.Before(other.CreatedAt))
			keepID, dropID := row.id, n.ID
			dropNamespace := other.Namespace
			if !keepRow {
				keepID, dropID = n.ID, row.id
				dropNamespace = row.namespace
			}
			if err := e.mergeEntries(ctx, row.userID, row.projectID, keepID, dropID, dropNamespace); err != nil {
				e.log.Warn("dream merge failed", "dropId", dropID, "keepId", keepID, "err", err)
				continue
			}
			out.Merged++
			mergedSet[dropID] = true
			if dropID == row.id {
				break // the current row was the loser
			}
		}
	}

	promoted, err := e.promoteCommonNeighborEdges(ctx)
	if err != nil {
		return out, err
	}
	out.EdgesPromoted = promoted
	out.DurationMs = time.Since(started).Milliseconds()
	return out, nil
}

// mergeEntries folds `dropId` into `keepId`: sum hits, redirect edges,
// delete the loser's shadow rows, warm row and cold vector.
func (e *Engine) mergeEntries(ctx context.Context, userID string, projectID *string, keepID, dropID, dropNamespace string) error {
	pool := e.warm.Pool
	if _, err := pool.Exec(ctx, `
		UPDATE memory_access SET hits = hits + COALESCE(
		    (SELECT hits FROM memory_access WHERE entry_id = $2), 0),
		    last_accessed = greatest(last_accessed,
		      COALESCE((SELECT last_accessed FROM memory_access WHERE entry_id = $2), last_accessed))
		 WHERE entry_id = $1`, keepID, dropID); err != nil {
		return err
	}
	for _, q := range []string{
		`UPDATE memory_relations SET to_id = $1 WHERE to_id = $2 AND from_id <> $1`,
		`UPDATE memory_relations SET from_id = $1 WHERE from_id = $2 AND to_id <> $1`,
	} {
		if _, err := pool.Exec(ctx, q, keepID, dropID); err != nil {
			return err
		}
	}
	for _, q := range []string{
		`DELETE FROM memory_relations WHERE from_id = $1 OR to_id = $1`,
		`DELETE FROM memory_fts WHERE entry_id = $1`,
		`DELETE FROM memory_access WHERE entry_id = $1`,
		`DELETE FROM memory_entries WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, q, dropID); err != nil {
			return err
		}
	}
	if e.cold != nil {
		if err := e.cold.Delete(ctx, userID, dropNamespace, dropID, projectID); err != nil {
			e.log.Warn("dream cold.delete failed", "dropId", dropID, "err", err)
		}
	}
	return nil
}

// promoteCommonNeighborEdges adds a co_inferred edge for every pair
// sharing at least dreamEdgeMinCommon co_occurs neighbours. User and
// project isolation are enforced in SQL so a future cross-user co_occurs
// path can't bleed inferences between users.
func (e *Engine) promoteCommonNeighborEdges(ctx context.Context) (int, error) {
	tag, err := e.warm.Pool.Exec(ctx, `
		WITH co AS (
		  SELECT r1.from_id AS a, r2.from_id AS b, ea.user_id AS user_id, COUNT(*) AS c
		    FROM memory_relations r1
		    JOIN memory_relations r2 ON r1.to_id = r2.to_id AND r1.from_id <> r2.from_id
		    JOIN memory_entries ea ON ea.id = r1.from_id
		    JOIN memory_entries eb ON eb.id = r2.from_id
		   WHERE r1.relation = 'co_occurs' AND r2.relation = 'co_occurs'
		     AND ea.user_id = eb.user_id
		     AND COALESCE(ea.project_id, '') = COALESCE(eb.project_id, '')
		   GROUP BY r1.from_id, r2.from_id, ea.user_id
		  HAVING COUNT(*) >= $1
		)
		INSERT INTO memory_relations (user_id, from_id, to_id, relation, strength)
		SELECT co.user_id, co.a, co.b, 'co_inferred', LEAST(0.5 + (co.c::real / 20.0), 0.9)
		  FROM co
		ON CONFLICT (from_id, to_id, relation) DO NOTHING`, dreamEdgeMinCommon)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
