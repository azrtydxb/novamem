// Entry CRUD. Transcribed from packages/server/src/warm-store/index.ts:
// insertEntry, findByContentHash, getEntry, getEntryScope, getEntries,
// bumpHits, listNamespaces, listRecent, updateEntry, isEmbedded, stats —
// plus the four-delete transaction that lives in engine.forget in TS
// (engine/index.ts) but belongs with the other SQL here.
package warmstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type InsertEntryArgs struct {
	UserID       string
	ProjectID    *string
	Content      string
	Namespace    string
	Source       string
	AgentName    *string
	Metadata     map[string]any
	SourceType   *string
	CapturedFrom *string
	Confidence   *float64 // nil → column default 1.0
	ContentHash  *string
	// facts_pending_at / graph_pending_at are written in the SAME
	// statement as the row: this chunk owes a fact-extraction pass and
	// vector-neighbour edges, and the debt must survive a crash in the
	// window between INSERT and the fire-and-forget schedule. Both are
	// nil when the corresponding feature is unconfigured.
	FactsPendingAt *time.Time
	GraphPendingAt *time.Time
}

// InsertEntry writes the three-row transaction: memory_entries +
// memory_fts shadow (tsv is a GENERATED column — to_tsvector('english',
// content), added by ensureFtsExtras in TS, so no tsv value is written
// here) + memory_access. ON CONFLICT DO NOTHING closes the
// check-then-act race with FindByContentHash: on a lost race the
// concurrent winner's id is returned, as in TS.
func (s *Store) InsertEntry(ctx context.Context, id string, a InsertEntryArgs) (string, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	metadata := a.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	var winner string
	err = tx.QueryRow(ctx, `
		INSERT INTO memory_entries
			(id, user_id, project_id, content, namespace, source, agent_name, metadata,
			 source_type, captured_from, confidence, content_hash, facts_pending_at, graph_pending_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::real, 1.0),$12,$13,$14)
		ON CONFLICT DO NOTHING
		RETURNING id`,
		id, a.UserID, a.ProjectID, a.Content, a.Namespace, a.Source, a.AgentName, metadata,
		a.SourceType, a.CapturedFrom, a.Confidence, a.ContentHash, a.FactsPendingAt, a.GraphPendingAt,
	).Scan(&winner)
	if errors.Is(err, pgx.ErrNoRows) {
		// Lost the race — return the concurrent writer's id (dedup hit).
		// IS NOT DISTINCT FROM matches the TS null-branch handling.
		err = tx.QueryRow(ctx, `
			SELECT id FROM memory_entries
			WHERE user_id = $1
			  AND content_hash IS NOT DISTINCT FROM $2
			  AND project_id IS NOT DISTINCT FROM $3
			LIMIT 1`, a.UserID, a.ContentHash, a.ProjectID).Scan(&winner)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("insertEntry: conflict with no resolvable existing row")
		}
		if err != nil {
			return "", err
		}
		return winner, tx.Commit(ctx)
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO memory_fts (entry_id, user_id, project_id, content, namespace)
		VALUES ($1,$2,$3,$4,$5)`,
		winner, a.UserID, a.ProjectID, a.Content, a.Namespace); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO memory_access (entry_id) VALUES ($1)`, winner); err != nil {
		return "", err
	}
	return winner, tx.Commit(ctx)
}

// FindByContentHash — dedup scope is (user, project, hash), namespaces
// deliberately excluded; the returned namespace is the match's own shelf.
func (s *Store) FindByContentHash(ctx context.Context, userID string, projectID *string, hash string) (id, namespace string, found bool, err error) {
	err = s.Pool.QueryRow(ctx, `
		SELECT id, namespace FROM memory_entries
		WHERE user_id = $1 AND content_hash = $2 AND project_id IS NOT DISTINCT FROM $3
		LIMIT 1`, userID, hash, projectID).Scan(&id, &namespace)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return id, namespace, true, nil
}

// GetEntry applies the TS scope discipline: when projectID is set the
// project IS the access boundary (user_id not checked — members may be
// different users); otherwise user-wide entries only. Returns nil when
// out of scope or missing.
func (s *Store) GetEntry(ctx context.Context, userID, id string, projectID *string) (*Entry, error) {
	e, err := scanEntry(s.Pool.QueryRow(ctx,
		`SELECT `+entryColumns+` FROM memory_entries WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if projectID != nil {
		if e.ProjectID == nil || *e.ProjectID != *projectID {
			return nil, nil
		}
		return e, nil
	}
	if e.ProjectID != nil || e.UserID != userID {
		return nil, nil
	}
	return e, nil
}

// GetEntryScope — by id alone, no scope filter; used by forget/update
// paths to recheck actual project membership before mutation.
func (s *Store) GetEntryScope(ctx context.Context, id string) (userID string, projectID *string, found bool, err error) {
	err = s.Pool.QueryRow(ctx,
		`SELECT user_id, project_id FROM memory_entries WHERE id = $1 LIMIT 1`, id,
	).Scan(&userID, &projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, false, nil
	}
	if err != nil {
		return "", nil, false, err
	}
	return userID, projectID, true, nil
}

// BumpHits upserts memory_access (warm-store/index.ts bumpHits).
func (s *Store) BumpHits(ctx context.Context, id string) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO memory_access (entry_id, hits, last_accessed) VALUES ($1, 1, now())
		ON CONFLICT (entry_id) DO UPDATE SET
			hits = memory_access.hits + 1, last_accessed = now()`, id)
	return err
}

// IsEmbedded — the dedup fast-path must not claim searchability it did
// not produce (warm-store/index.ts isEmbedded).
func (s *Store) IsEmbedded(ctx context.Context, id string) (bool, error) {
	var embedded bool
	err := s.Pool.QueryRow(ctx,
		`SELECT embedded_at IS NOT NULL FROM memory_entries WHERE id = $1 LIMIT 1`, id,
	).Scan(&embedded)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return embedded, err
}

// SetEmbeddedAt with a nil time re-queues the entry for the embedding
// reconciler (embedded_at IS NULL is the queue) — used by update when
// content changed but no vector was written.
func (s *Store) SetEmbeddedAt(ctx context.Context, id string, at *time.Time) error {
	_, err := s.Pool.Exec(ctx, `UPDATE memory_entries SET embedded_at = $2 WHERE id = $1`, id, at)
	return err
}

// scopeClause reproduces the three isolation modes shared by
// listNamespaces / listRecent in TS, appending its own parameters.
// The clause appends exactly the parameters it references — a
// project-scoped read must not leave an unreferenced $1 in the statement,
// which Postgres rejects outright ("could not determine data type of
// parameter $1").
func scopeClause(userID string, projectID *string, includeProjects []string, args *[]any) string {
	if len(includeProjects) > 0 {
		*args = append(*args, userID, includeProjects)
		n := len(*args)
		return fmt.Sprintf(`((user_id = $%d AND project_id IS NULL) OR project_id = ANY($%d))`, n-1, n)
	}
	if projectID != nil {
		*args = append(*args, *projectID)
		return fmt.Sprintf(`project_id = $%d`, len(*args))
	}
	*args = append(*args, userID)
	return fmt.Sprintf(`(user_id = $%d AND project_id IS NULL)`, len(*args))
}

// ListNamespaces — distinct namespaces with entries visible in scope
// (warm-store/index.ts listNamespaces). Used for the recent fanout when
// the caller specifies neither namespace nor includeNamespaces.
func (s *Store) ListNamespaces(ctx context.Context, userID string, projectID *string, includeProjects []string) ([]string, error) {
	args := []any{}
	scope := scopeClause(userID, projectID, includeProjects, &args)
	rows, err := s.Pool.Query(ctx,
		`SELECT DISTINCT namespace FROM memory_entries WHERE `+scope, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var ns string
		if err := rows.Scan(&ns); err != nil {
			return nil, err
		}
		out = append(out, ns)
	}
	return out, rows.Err()
}

// ListRecent — newest first within scope (warm-store/index.ts listRecent).
// since is inclusive (created_at >= since), matching the TS gte().
func (s *Store) ListRecent(ctx context.Context, userID string, namespaces []string, k int, projectID *string, includeProjects []string, since *time.Time) ([]Entry, error) {
	if len(namespaces) == 0 {
		return nil, nil
	}
	args := []any{}
	scope := scopeClause(userID, projectID, includeProjects, &args)
	args = append(args, namespaces)
	nsCond := fmt.Sprintf(`namespace = ANY($%d)`, len(args))
	sinceCond := ""
	if since != nil {
		args = append(args, *since)
		sinceCond = fmt.Sprintf(` AND created_at >= $%d`, len(args))
	}
	args = append(args, k)
	q := `SELECT ` + entryColumns + ` FROM memory_entries WHERE ` + nsCond + ` AND ` + scope +
		sinceCond + fmt.Sprintf(` ORDER BY created_at DESC LIMIT $%d`, len(args))
	rows, err := s.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

type UpdateEntryArgs struct {
	UserID       string
	ID           string
	ProjectID    *string
	Content      *string
	Namespace    *string
	Metadata     map[string]any // nil = leave unchanged
	SourceType   *string
	CapturedFrom *string
	Confidence   *float64
	ContentHash  *string
}

// UpdateEntry — in-place update preserving created_at / hits / edges
// (warm-store/index.ts updateEntry). Scope check first, then the entry
// row and its FTS shadow move in one transaction. Returns false when the
// id doesn't exist in the caller's scope.
func (s *Store) UpdateEntry(ctx context.Context, a UpdateEntryArgs) (bool, error) {
	scopeUser, scopeProject, found, err := s.GetEntryScope(ctx, a.ID)
	if err != nil {
		return false, err
	}
	if !found {
		return false, nil
	}
	if a.ProjectID != nil {
		if scopeProject == nil || *scopeProject != *a.ProjectID {
			return false, nil
		}
	} else {
		if scopeProject != nil || scopeUser != a.UserID {
			return false, nil
		}
	}

	set := []string{"updated_at = now()"}
	args := []any{a.ID}
	add := func(col string, v any) {
		args = append(args, v)
		set = append(set, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if a.Content != nil {
		add("content", *a.Content)
	}
	if a.Namespace != nil {
		add("namespace", *a.Namespace)
	}
	if a.Metadata != nil {
		add("metadata", a.Metadata)
	}
	if a.SourceType != nil {
		add("source_type", *a.SourceType)
	}
	if a.CapturedFrom != nil {
		add("captured_from", *a.CapturedFrom)
	}
	if a.Confidence != nil {
		add("confidence", *a.Confidence)
	}
	if a.ContentHash != nil {
		add("content_hash", *a.ContentHash)
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx,
		`UPDATE memory_entries SET `+strings.Join(set, ", ")+` WHERE id = $1`, args...); err != nil {
		return false, err
	}
	if a.Content != nil || a.Namespace != nil {
		fset := []string{}
		fargs := []any{a.ID}
		fadd := func(col string, v any) {
			fargs = append(fargs, v)
			fset = append(fset, fmt.Sprintf("%s = $%d", col, len(fargs)))
		}
		if a.Content != nil {
			fadd("content", *a.Content)
		}
		if a.Namespace != nil {
			fadd("namespace", *a.Namespace)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE memory_fts SET `+strings.Join(fset, ", ")+` WHERE entry_id = $1`, fargs...); err != nil {
			return false, err
		}
	}
	return true, tx.Commit(ctx)
}

// DeleteEntry runs forget's four-delete transaction (engine/index.ts
// forget). When the entry is project-scoped, project_id is the access
// boundary; otherwise user_id. The caller has already resolved the
// entry (GetEntry) — this only deletes.
func (s *Store) DeleteEntry(ctx context.Context, id string, entryProjectID *string, userID string) error {
	scope := "user_id = $2"
	scopeValue := userID
	if entryProjectID != nil {
		scope = "project_id = $2"
		scopeValue = *entryProjectID
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `DELETE FROM memory_fts WHERE entry_id = $1 AND `+scope, id, scopeValue); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM memory_access WHERE entry_id = $1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM memory_relations WHERE (from_id = $1 OR to_id = $1) AND `+scope, id, scopeValue); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM memory_entries WHERE id = $1 AND `+scope, id, scopeValue); err != nil {
		return err
	}
	return tx.Commit(ctx)
	// slice 3: the TS server then deletes the cold-store vector, parking
	// the id in cold_orphans on failure. There is no cold store in the Go
	// server yet, and Go-written rows have no vectors, so nothing is
	// deleted and nothing is parked here — parking unconditionally would
	// hand the reaper permanent no-op work.
}

// Stats — per-namespace warm/cold counts over everything visible to the
// user (warm-store/index.ts stats / visibleMemoryWhere), plus the last
// decay run's finish time.
type StatsRow struct {
	Namespace string
	Cold      bool
	Count     int64
}

func (s *Store) Stats(ctx context.Context, userID string) ([]StatsRow, *time.Time, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT namespace, cold, count(*) FROM memory_entries
		WHERE (user_id = $1 AND project_id IS NULL)
		   OR EXISTS (SELECT 1 FROM project_members pm
		              WHERE pm.project_id = memory_entries.project_id AND pm.user_id = $1)
		GROUP BY namespace, cold`, userID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var out []StatsRow
	for rows.Next() {
		var r StatsRow
		if err := rows.Scan(&r.Namespace, &r.Cold, &r.Count); err != nil {
			return nil, nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var lastDecay *time.Time
	err = s.Pool.QueryRow(ctx,
		`SELECT finished_at FROM decay_runs ORDER BY id DESC LIMIT 1`).Scan(&lastDecay)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, err
	}
	return out, lastDecay, nil
}
