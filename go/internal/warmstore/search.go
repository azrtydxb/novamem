// Search-side warm-store methods for slice 3. Transcribed from
// packages/server/src/warm-store/index.ts: ftsSearch, getEntries,
// bumpHitsMany, getColdEntryStatsMany, markCold, addRelation,
// neighborsByRelations, listHygieneEntries, recordMissingVector,
// clearMissingVector, setGraphPendingAt — plus the cold_orphans
// delete-parking INSERT that lives in engine.forget in TS.
package warmstore

import (
	"context"
	"fmt"
	"time"
)

type FtsArgs struct {
	UserID string
	// When set, project IS the isolation unit — user_id is NOT filtered
	// (membership already verified at the auth layer). Otherwise scope to
	// user-wide entries (project_id IS NULL).
	ProjectID *string
	Query     string
	// Single-namespace search; ignored when Namespaces is set.
	Namespace string
	// Cross-namespace union via namespace = ANY(...).
	Namespaces []string
	K          int
	// Tri-state agent filter: unset (any agent), nil-valued set (agent
	// IS NULL), or a concrete name.
	AgentName    *string
	AgentNameSet bool
}

type ScoredID struct {
	ID    string
	Score float64
}

// FtsSearch — the single-pass strict-preference query (warm-store/
// index.ts ftsSearch): match the loose (OR-rewritten) superset once,
// flag rows that also satisfy the strict websearch_to_tsquery form,
// rank each row against the form it satisfies, order strict-first, then
// keep only strict rows when any exist. The user's text stays a bound
// parameter throughout.
func (s *Store) FtsSearch(ctx context.Context, a FtsArgs) ([]ScoredID, error) {
	args := []any{a.Query}
	var nsSQL string
	if len(a.Namespaces) > 0 {
		args = append(args, a.Namespaces)
		nsSQL = fmt.Sprintf("f.namespace = ANY($%d)", len(args))
	} else {
		args = append(args, a.Namespace)
		nsSQL = fmt.Sprintf("f.namespace = $%d", len(args))
	}
	var scopeSQL string
	if a.ProjectID != nil {
		args = append(args, *a.ProjectID)
		scopeSQL = fmt.Sprintf("f.project_id = $%d", len(args))
	} else {
		args = append(args, a.UserID)
		scopeSQL = fmt.Sprintf("f.user_id = $%d AND f.project_id IS NULL", len(args))
	}
	agentSQL := "TRUE"
	joinSQL := ""
	if a.AgentNameSet {
		joinSQL = "JOIN memory_entries e ON e.id = f.entry_id"
		if a.AgentName == nil {
			agentSQL = "e.agent_name IS NULL"
		} else {
			args = append(args, *a.AgentName)
			agentSQL = fmt.Sprintf("e.agent_name = $%d", len(args))
		}
	}
	args = append(args, a.K)
	q := fmt.Sprintf(`
		WITH q AS (
			SELECT websearch_to_tsquery('english', $1) AS strict,
			       replace(websearch_to_tsquery('english', $1)::text, '&', '|')::tsquery AS loose
		)
		SELECT entry_id, is_strict, score FROM (
			SELECT f.entry_id,
			       (f.tsv @@ q.strict) AS is_strict,
			       ts_rank_cd(f.tsv, CASE WHEN f.tsv @@ q.strict THEN q.strict ELSE q.loose END) AS score
			FROM memory_fts f %s, q
			WHERE %s AND %s AND %s AND f.tsv @@ q.loose
		) t
		ORDER BY is_strict DESC, score DESC
		LIMIT $%d`, joinSQL, nsSQL, scopeSQL, agentSQL, len(args))
	rows, err := s.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type row struct {
		id       string
		isStrict bool
		score    float64
	}
	var all []row
	for rows.Next() {
		var r row
		var score float32 // ts_rank_cd returns real
		if err := rows.Scan(&r.id, &r.isStrict, &score); err != nil {
			return nil, err
		}
		r.score = float64(score)
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	anyStrict := len(all) > 0 && all[0].isStrict
	out := make([]ScoredID, 0, len(all))
	for _, r := range all {
		if anyStrict && !r.isStrict {
			continue
		}
		out = append(out, ScoredID{ID: r.id, Score: r.score})
	}
	return out, nil
}

// GetEntries — batch lookup returning rows in input order with nil slots
// for missing/cross-scope ids (warm-store/index.ts getEntries).
// includeProjects (active-project mode): row visible if user-global for
// this caller OR in one of the listed (membership-checked) projects.
func (s *Store) GetEntries(ctx context.Context, userID string, ids []string, projectID *string, includeProjects []string) ([]*Entry, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+entryColumns+` FROM memory_entries WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	includeSet := map[string]bool{}
	for _, p := range includeProjects {
		includeSet[p] = true
	}
	byID := map[string]*Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		switch {
		case len(includeProjects) > 0:
			ok := (e.ProjectID == nil && e.UserID == userID) ||
				(e.ProjectID != nil && includeSet[*e.ProjectID])
			if !ok {
				continue
			}
		case projectID != nil:
			if e.ProjectID == nil || *e.ProjectID != *projectID {
				continue
			}
		default:
			if e.ProjectID != nil || e.UserID != userID {
				continue
			}
		}
		byID[e.ID] = e
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]*Entry, len(ids))
	for i, id := range ids {
		out[i] = byID[id]
	}
	return out, nil
}

// BumpHitsMany — one round-trip for the whole top-k; dedupes internally
// (Postgres rejects ON CONFLICT DO UPDATE touching a row twice).
func (s *Store) BumpHitsMany(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	seen := map[string]bool{}
	unique := ids[:0:0]
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO memory_access (entry_id, hits, last_accessed)
		SELECT unnest($1::text[]), 1, now()
		ON CONFLICT (entry_id) DO UPDATE SET
			hits = memory_access.hits + 1, last_accessed = now()`, unique)
	return err
}

type ColdStats struct {
	Hits     int
	IdleDays float64
}

// GetColdEntryStatsMany — batch access-stats read for the cold slice of
// a search top-k; ids without an access row are absent from the map.
func (s *Store) GetColdEntryStatsMany(ctx context.Context, ids []string) (map[string]ColdStats, error) {
	out := map[string]ColdStats{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT entry_id, hits,
		       EXTRACT(EPOCH FROM (now() - last_accessed)) / 86400.0
		FROM memory_access WHERE entry_id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var st ColdStats
		var idle *float64 // last_accessed may be NULL
		if err := rows.Scan(&id, &st.Hits, &idle); err != nil {
			return nil, err
		}
		if idle != nil {
			st.IdleDays = *idle
		}
		out[id] = st
	}
	return out, rows.Err()
}

// MarkCold flips the warm/cold flag (promotion path).
func (s *Store) MarkCold(ctx context.Context, id string, cold bool) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE memory_entries SET cold = $2, updated_at = now() WHERE id = $1`, id, cold)
	return err
}

// AddRelation — idempotent edge upsert; repeat links refresh strength
// (warm-store/index.ts addRelation).
func (s *Store) AddRelation(ctx context.Context, userID, fromID, toID, relation string, strength float64, projectID *string) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO memory_relations (user_id, project_id, from_id, to_id, relation, strength)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (from_id, to_id, relation) DO UPDATE SET strength = EXCLUDED.strength`,
		userID, projectID, fromID, toID, relation, strength)
	return err
}

// NeighborsByRelations — recursive undirected walk over memory_relations,
// depth 1..3, score = MAX over paths of the product of edge strengths;
// only currently-valid edges (valid_to IS NULL) are followed (asOf is
// accepted-but-unused on /v1/search; /v1/neighbors passes no asOf in the
// TS route either). Transcribed from warm-store/index.ts
// neighborsByRelations with asOfMs = null.
func (s *Store) NeighborsByRelations(ctx context.Context, userID, seedID string, depth, limit int, projectID *string) ([]ScoredID, error) {
	if depth < 1 {
		depth = 1
	}
	if depth > 3 {
		depth = 3
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	scope := "project_id IS NULL"
	args := []any{userID, seedID, depth, limit}
	if projectID != nil {
		args = append(args, *projectID)
		scope = fmt.Sprintf("project_id = $%d", len(args))
	}
	q := fmt.Sprintf(`
		WITH RECURSIVE edges AS (
			SELECT from_id, to_id, strength FROM memory_relations
			WHERE user_id = $1 AND %[1]s AND valid_to IS NULL
			UNION ALL
			SELECT to_id AS from_id, from_id AS to_id, strength FROM memory_relations
			WHERE user_id = $1 AND %[1]s AND valid_to IS NULL
		), walk AS (
			SELECT e.to_id AS id, e.strength::float8 AS score, 1 AS hop,
			       ARRAY[$2::text, e.to_id] AS path
			FROM edges e WHERE e.from_id = $2
			UNION ALL
			SELECT e.to_id, (w.score * e.strength)::float8, w.hop + 1,
			       w.path || e.to_id
			FROM walk w JOIN edges e ON e.from_id = w.id
			WHERE w.hop < $3 AND NOT e.to_id = ANY(w.path)
		)
		SELECT id, MAX(score) AS score FROM walk
		WHERE id <> $2
		GROUP BY id
		ORDER BY score DESC
		LIMIT $4`, scope)
	rows, err := s.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ScoredID
	for rows.Next() {
		var r ScoredID
		if err := rows.Scan(&r.ID, &r.Score); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// HygieneEntry is the projection listHygieneEntries returns.
type HygieneEntry struct {
	ID        string
	UserID    string
	ProjectID *string
	Content   string
	Namespace string
	Metadata  map[string]any
}

// ListHygieneEntries — rows visible to the hygiene report (user-global +
// member projects), newest-updated first (warm-store/index.ts).
func (s *Store) ListHygieneEntries(ctx context.Context, userID string, k int) ([]HygieneEntry, error) {
	if k == 0 {
		k = 400
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT id, user_id, project_id, content, namespace, metadata
		FROM memory_entries
		WHERE (user_id = $1 AND project_id IS NULL)
		   OR EXISTS (SELECT 1 FROM project_members pm
		              WHERE pm.project_id = memory_entries.project_id AND pm.user_id = $1)
		ORDER BY updated_at DESC
		LIMIT $2`, userID, k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HygieneEntry
	for rows.Next() {
		var e HygieneEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.ProjectID, &e.Content, &e.Namespace, &e.Metadata); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// RecordMissingVector queues a warm entry whose cold vector is missing
// (kind 'backfill') so the reaper can re-embed it later.
func (s *Store) RecordMissingVector(ctx context.Context, userID string, projectID *string, entryID, namespace string) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO cold_orphans (id, user_id, namespace, project_id, kind, attempts, last_attempt_at)
		VALUES ($1, $2, $3, $4, 'backfill', 0, NULL)
		ON CONFLICT (id) DO UPDATE SET
			kind = 'backfill',
			namespace = EXCLUDED.namespace,
			project_id = EXCLUDED.project_id`,
		entryID, userID, namespace, projectID)
	return err
}

// ClearMissingVector drops a backfill row once the vector is present.
func (s *Store) ClearMissingVector(ctx context.Context, entryID string) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM cold_orphans WHERE id = $1 AND kind = 'backfill'`, entryID)
	return err
}

// RecordColdOrphan parks a delete-kind orphan after a failed cold delete
// (engine/index.ts forget's cold-failure INSERT).
func (s *Store) RecordColdOrphan(ctx context.Context, id, userID, namespace string, projectID *string, lastError string) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO cold_orphans (id, user_id, namespace, project_id, attempts, last_error, last_attempt_at)
		VALUES ($1, $2, $3, $4, 1, $5, now())
		ON CONFLICT (id) DO UPDATE SET
			attempts = cold_orphans.attempts + 1,
			last_error = EXCLUDED.last_error,
			last_attempt_at = now()`,
		id, userID, namespace, projectID, lastError)
	return err
}

// SetGraphPendingAt clears (or re-arms) the pending-enrichment marker.
func (s *Store) SetGraphPendingAt(ctx context.Context, id string, at *time.Time) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE memory_entries SET graph_pending_at = $2 WHERE id = $1`, id, at)
	return err
}
