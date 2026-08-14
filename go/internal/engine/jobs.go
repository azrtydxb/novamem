// Background-job engine methods: the decay sweep (demote + TTL reap +
// changelog prune), the cold-orphan reaper, the embedding/enrichment
// reconcilers, admin user teardown and the deep-health snapshot.
// Transcribed from packages/server/src/engine/index.ts (decay,
// reapExpired, reapOrphans, reconcilePendingEmbeddings,
// reconcilePendingEnrichment, deleteUser, health).
package engine

import (
	"context"
	"time"

	"github.com/azrtydxb/novamem/go/internal/coldstore"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// DecayResult — POST /v1/decay's body.
type DecayResult struct {
	Demoted  int `json:"demoted"`
	Promoted int `json:"promoted"`
	Expired  int `json:"expired"`
}

// Decay demotes idle warm entries, reaps TTL-expired ones and prunes the
// changelog. The lifespan formula (`base × log₂(hits+1)`) is the SQL twin
// of EffectiveDays — frequently-used memories resist decay because their
// lifespan grows with use. One bulk statement regardless of candidate
// count.
func (e *Engine) Decay(ctx context.Context, effectiveDaysOverride float64) (DecayResult, error) {
	base := effectiveDaysOverride
	if base <= 0 {
		base = e.defaultEffectiveDays
	}
	var runID *int64
	var id int64
	if err := e.warm.Pool.QueryRow(ctx,
		`INSERT INTO decay_runs (started_at, effective_days) VALUES (now(), $1) RETURNING id`,
		base).Scan(&id); err != nil {
		// A missing run row costs an operator-visible history entry, not
		// the sweep itself.
		e.log.Warn("decay: could not open a decay_runs row", "err", err)
	} else {
		runID = &id
	}
	tag, err := e.warm.Pool.Exec(ctx, `
		WITH candidates AS (
		  SELECT e.id,
		         COALESCE(a.hits, 0) AS hits,
		         EXTRACT(EPOCH FROM (now() - COALESCE(a.last_accessed, e.created_at))) / 86400.0 AS idle_days,
		         COALESCE(NULLIF(e.metadata->'retention'->>'baseEffectiveDays', '')::double precision, $1::double precision) AS base_days
		    FROM memory_entries e
		    LEFT JOIN memory_access a ON a.entry_id = e.id
		   WHERE e.cold = false
		),
		to_demote AS (
		  SELECT id FROM candidates
		   WHERE idle_days > (base_days * log(2.0, GREATEST(hits, 0) + 1))
		)
		UPDATE memory_entries SET cold = true, updated_at = now()
		 WHERE id IN (SELECT id FROM to_demote)`, base)
	if err != nil {
		return DecayResult{}, err
	}
	demoted := int(tag.RowsAffected())
	promoted := int(e.promotedSinceLastDecay.Swap(0))
	if runID != nil {
		if _, err := e.warm.Pool.Exec(ctx,
			`UPDATE decay_runs SET finished_at = now(), demoted = $1, promoted = $2 WHERE id = $3`,
			demoted, promoted, *runID); err != nil {
			e.log.Warn("decay: could not close the decay_runs row", "err", err)
		}
	}
	if e.metrics != nil {
		e.metrics.MarkDecayRun(time.Now())
		e.metrics.RecordDemotion(demoted)
	}
	expired, err := e.reapExpired(ctx)
	if err != nil {
		return DecayResult{Demoted: demoted, Promoted: promoted}, err
	}
	// Changelog retention: 30 days is plenty for an orchestrator polling
	// /v1/me/changes, and unbounded growth would eventually dominate.
	if _, err := e.warm.PruneChanges(ctx, 30); err != nil {
		e.log.Warn("decay: changelog prune failed", "err", err)
	}
	return DecayResult{Demoted: demoted, Promoted: promoted, Expired: expired}, nil
}

// reapExpired hard-deletes entries whose explicit TTL has passed. Reads
// already hide them, so this is storage hygiene; bounded per pass, the
// remainder is picked up next tick. Cold-vector failures park in
// cold_orphans exactly like forget's.
func (e *Engine) reapExpired(ctx context.Context) (int, error) {
	rows, err := e.warm.Pool.Query(ctx, `
		SELECT id, user_id, project_id, namespace
		  FROM memory_entries
		 WHERE metadata->>'expiresAt' IS NOT NULL
		   AND (metadata->>'expiresAt')::timestamptz <= now()
		 LIMIT 1000`)
	if err != nil {
		return 0, err
	}
	type expiredRow struct {
		id, userID, namespace string
		projectID             *string
	}
	var batch []expiredRow
	for rows.Next() {
		var r expiredRow
		if err := rows.Scan(&r.id, &r.userID, &r.projectID, &r.namespace); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(batch) == 0 {
		return 0, nil
	}
	ids := make([]string, len(batch))
	for i, r := range batch {
		ids[i] = r.id
	}
	tx, err := e.warm.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, q := range []string{
		`DELETE FROM memory_fts WHERE entry_id = ANY($1)`,
		`DELETE FROM memory_access WHERE entry_id = ANY($1)`,
		`DELETE FROM memory_relations WHERE from_id = ANY($1) OR to_id = ANY($1)`,
		`DELETE FROM memory_entries WHERE id = ANY($1)`,
	} {
		if _, err := tx.Exec(ctx, q, ids); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	changes := make([]warmstore.ChangeRow, 0, len(batch))
	for _, r := range batch {
		if e.cold != nil {
			if err := e.cold.Delete(ctx, r.userID, r.namespace, r.id, r.projectID); err != nil {
				// Same parking as forget's cold-failure path: the reaper
				// retries on the decay schedule until the vector is gone.
				if err := e.warm.RecordColdOrphan(ctx, r.id, r.userID, r.namespace, r.projectID, err.Error()); err != nil {
					e.log.Warn("reapExpired: could not park cold orphan", "entryId", r.id, "err", err)
				}
			}
		}
		changes = append(changes, warmstore.ChangeRow{
			UserID: r.userID, ProjectID: r.projectID, EntryID: r.id, Change: "expired",
		})
	}
	if err := e.warm.RecordChanges(ctx, changes); err != nil {
		e.log.Warn("reapExpired: changelog append failed", "err", err)
	}
	e.log.Info("reaped expired (TTL) entries", "expired", len(ids))
	return len(ids), nil
}

// ReapOrphansResult — POST /v1/reap-orphans' body. Two counters so
// operators see both retry-eligible work AND the permanently-stuck tail.
type ReapOrphansResult struct {
	Attempted int `json:"attempted"`
	Cleared   int `json:"cleared"`
	Abandoned int `json:"abandoned"`
	Pending   int `json:"pending"`
	Total     int `json:"total"`
}

const (
	orphanMaxAttempts = 10
	orphanBatch       = 100
)

// ReapOrphans drains the cold_orphans queue: `delete`-kind rows retry the
// cold delete, `backfill`-kind rows re-embed the entry's vector.
func (e *Engine) ReapOrphans(ctx context.Context) (ReapOrphansResult, error) {
	rows, err := e.warm.Pool.Query(ctx, `
		SELECT id, user_id, namespace, project_id, attempts, kind FROM cold_orphans
		 WHERE attempts < $1 ORDER BY last_attempt_at ASC NULLS FIRST LIMIT $2`,
		orphanMaxAttempts, orphanBatch)
	if err != nil {
		return ReapOrphansResult{}, err
	}
	type orphan struct {
		id, userID, namespace, kind string
		projectID                   *string
		attempts                    int
	}
	var batch []orphan
	for rows.Next() {
		var o orphan
		if err := rows.Scan(&o.id, &o.userID, &o.namespace, &o.projectID, &o.attempts, &o.kind); err != nil {
			rows.Close()
			return ReapOrphansResult{}, err
		}
		batch = append(batch, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ReapOrphansResult{}, err
	}
	out := ReapOrphansResult{Attempted: len(batch)}
	for _, o := range batch {
		var opErr error
		if o.kind == "backfill" {
			opErr = e.backfillOrphanVector(ctx, o.id, o.userID, o.namespace, o.projectID)
		} else if e.cold != nil {
			opErr = e.cold.Delete(ctx, o.userID, o.namespace, o.id, o.projectID)
		}
		if opErr == nil {
			if _, err := e.warm.Pool.Exec(ctx, `DELETE FROM cold_orphans WHERE id = $1`, o.id); err != nil {
				return out, err
			}
			out.Cleared++
			continue
		}
		attempts := o.attempts + 1
		if _, err := e.warm.Pool.Exec(ctx,
			`UPDATE cold_orphans SET attempts = $1, last_error = $2, last_attempt_at = now() WHERE id = $3`,
			attempts, opErr.Error(), o.id); err != nil {
			return out, err
		}
		if attempts >= orphanMaxAttempts {
			out.Abandoned++
			e.log.Warn("cold orphan abandoned", "entryId", o.id, "attempts", attempts, "err", opErr)
		}
	}
	if err := e.warm.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FILTER (WHERE attempts < $1), COUNT(*) FROM cold_orphans`,
		orphanMaxAttempts).Scan(&out.Pending, &out.Total); err != nil {
		return out, err
	}
	if out.Cleared > 0 && e.metrics != nil {
		e.metrics.RecordOrphansReaped(out.Cleared)
	}
	return out, nil
}

// backfillOrphanVector re-embeds an entry whose cold write was lost and
// re-upserts it (the `backfill` orphan kind).
func (e *Engine) backfillOrphanVector(ctx context.Context, id, userID, namespace string, projectID *string) error {
	if !e.vectorTierReady() {
		return errNoEmbedder
	}
	var content, source string
	var agentName *string
	if err := e.warm.Pool.QueryRow(ctx,
		`SELECT content, source, agent_name FROM memory_entries WHERE id = $1`, id).Scan(&content, &source, &agentName); err != nil {
		return err
	}
	embedding, err := e.embedDocument(ctx, content)
	if err != nil {
		return err
	}
	if err := e.cold.Upsert(ctx, coldstore.UpsertArgs{
		UserID: userID, ProjectID: projectID, ID: id, Namespace: namespace,
		Embedding: embedding, Payload: e.vectorPayload(source, agentName),
	}); err != nil {
		return err
	}
	return e.warm.SetEmbeddedAt(ctx, id, ptrTime(time.Now()))
}

func ptrTime(t time.Time) *time.Time { return &t }

// ReconcileResult is the shared shape of the reconciler ticks.
type ReconcileResult struct {
	Scanned int `json:"scanned"`
	Done    int `json:"done"`
	Failed  int `json:"failed"`
	Pending int `json:"pending"`
}

// ReconcilePendingEmbeddings drains entries whose vector was never
// written (embedded_at IS NULL). No retry counter, no backoff, no
// dead-letter: embedding failures are shared (the endpoint is up or it
// isn't), so per-row backoff would only stagger a recovery in which
// every row succeeds on the same tick.
func (e *Engine) ReconcilePendingEmbeddings(ctx context.Context, batchSize int) (ReconcileResult, error) {
	out := ReconcileResult{}
	if !e.vectorTierReady() {
		return out, nil
	}
	rows, err := e.warm.ListPendingEmbedding(ctx, batchSize)
	if err != nil {
		return out, err
	}
	out.Scanned = len(rows)
	for _, row := range rows {
		if err := e.embedAndUpsert(ctx, row); err != nil {
			out.Failed++
			e.recordEmbedFailure(err, "reconcile", row.ID)
			continue
		}
		e.recordEmbedSuccess()
		out.Done++
	}
	pending, err := e.warm.CountPendingEmbedding(ctx)
	if err != nil {
		return out, err
	}
	out.Pending = pending
	e.pendingEmbeddings.Store(int64(pending))
	return out, nil
}

func (e *Engine) embedAndUpsert(ctx context.Context, row warmstore.PendingEntry) error {
	embedding, err := e.embedDocument(ctx, row.Content)
	if err != nil {
		return err
	}
	if err := e.cold.Upsert(ctx, coldstore.UpsertArgs{
		UserID: row.UserID, ProjectID: row.ProjectID, ID: row.ID, Namespace: row.Namespace,
		Embedding: embedding, Payload: e.vectorPayload(row.Source, row.AgentName),
	}); err != nil {
		return err
	}
	if err := e.warm.SetEmbeddedAt(ctx, row.ID, ptrTime(time.Now())); err != nil {
		return err
	}
	// A row that was also parked as a missing-vector orphan is repaired.
	return e.warm.ClearMissingVector(ctx, row.ID)
}

// ReconcilePendingEnrichment drains deferred graph enrichment (rows whose
// write-time attempt was capped, failed, or died in a crash). Sequential
// on purpose — the queue exists to prevent a pile-up, and a parallel
// drain would recreate it. Re-embeds content: the vector is not stored
// warm-side and an extra embed per backlog row beats a point-fetch
// dependency on the cold tier.
func (e *Engine) ReconcilePendingEnrichment(ctx context.Context, batchSize int) (ReconcileResult, error) {
	out := ReconcileResult{}
	if e.graphLinkFanout <= 0 || !e.vectorTierReady() {
		return out, nil
	}
	rows, err := e.warm.ListPendingEnrichment(ctx, batchSize)
	if err != nil {
		return out, err
	}
	out.Scanned = len(rows)
	for _, row := range rows {
		embedding, err := e.embedDocument(ctx, row.Content)
		if err == nil {
			err = e.enrichEntry(ctx, row.UserID, row.ProjectID, row.ID, row.Namespace, embedding)
		}
		if err != nil {
			out.Failed++
			e.log.Warn("enrichment reconcile failed (marker kept, will retry)",
				"entryId", row.ID, "err", err)
			continue
		}
		out.Done++
	}
	pending, err := e.warm.CountPendingEnrichment(ctx)
	if err != nil {
		return out, err
	}
	out.Pending = pending
	return out, nil
}

// DeleteUserResult — DELETE /v1/admin/users/{id}'s body.
type DeleteUserResult struct {
	Deleted         bool     `json:"deleted"`
	EntriesRemoved  int      `json:"entriesRemoved"`
	TokensRemoved   int      `json:"tokensRemoved"`
	ProjectsDeleted []string `json:"projectsDeleted"`
	ColdCleanup     []string `json:"coldCleanup"`
	ColdCleanupOK   bool     `json:"coldCleanupOk"`
	Reason          string   `json:"reason,omitempty"`
}

// DeleteUser removes everything a user owns: their projects first (each
// with its cold collection), then the warm remainder in one transaction,
// then the user's own vectors. A cold failure is reported, not fatal —
// the parked orphans get reaped.
func (e *Engine) DeleteUser(ctx context.Context, userID string) (DeleteUserResult, error) {
	out := DeleteUserResult{ProjectsDeleted: []string{}, ColdCleanup: []string{}, ColdCleanupOK: true}
	owned, err := e.warm.ListOwnedProjects(ctx, userID)
	if err != nil {
		return out, err
	}
	for _, projectID := range owned {
		r, err := e.DeleteProject(ctx, projectID, userID)
		if err != nil {
			return out, err
		}
		if r.Deleted {
			out.ProjectsDeleted = append(out.ProjectsDeleted, projectID)
		}
	}
	deleted, entries, tokens, reason, err := e.warm.DeleteUserData(ctx, userID)
	if err != nil {
		return out, err
	}
	if !deleted {
		out.Reason = reason
		return out, nil
	}
	out.Deleted, out.EntriesRemoved, out.TokensRemoved = true, entries, tokens
	if e.cold != nil {
		scopes, err := e.cold.DeleteAllForUser(ctx, userID)
		if err != nil {
			out.ColdCleanupOK = false
			e.log.Warn("deleteUser: cold cleanup failed — vectors remain until reaped",
				"userId", userID, "err", err)
		} else {
			out.ColdCleanup = scopes
		}
	}
	return out, nil
}

// Health is /v1/admin/health/deep's per-dependency snapshot. Deliberate
// asymmetry: a failing embedder and a pending backlog are reported but
// neither enters `ok` — keyword search still works without the embedder,
// so pulling the service out of rotation would turn a partial loss of
// recall into a total loss of memory.
func (e *Engine) Health(ctx context.Context) map[string]any {
	warmOK := e.warm.Ping(ctx)
	coldOK := e.cold == nil || e.cold.Ping(ctx)
	state := func(ok bool) string {
		if ok {
			return "ok"
		}
		return "unreachable"
	}
	embedder := "ok"
	if e.embedderFailing() {
		embedder = "failing"
	}
	var pending *int
	if n := e.pendingEmbeddings.Load(); n >= 0 {
		v := int(n)
		pending = &v
	}
	return map[string]any{
		"ok": warmOK && coldOK,
		"deps": map[string]any{
			"warm": state(warmOK),
			"cold": state(coldOK),
			// No graph service exists (relations live in SQL); the field
			// stays for wire compatibility.
			"graph":    "disabled",
			"embedder": embedder,
		},
		"pendingEmbeddings": pending,
	}
}
