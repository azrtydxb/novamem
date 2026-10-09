package warmstore

import (
	"context"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/azrtydxb/novamem/go/internal/tenant"
)

// AddSourceRefs merges refs into an existing entry (#338). Idempotent:
// a ref the entry already carries is left alone. The insert is a
// SELECT from memory_entries so a ref is never written for an entry that
// is gone (a forget racing a dedupe hit) and so the stored organization
// is the entry's own, not the caller's claim.
func (s *Store) AddSourceRefs(ctx context.Context, entryID string, refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	return addSourceRefs(ctx, s.Pool, entryID, refs)
}

// execer is satisfied by both the pool and an open transaction.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func addSourceRefs(ctx context.Context, q execer, entryID string, refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	_, err := q.Exec(ctx, `
		INSERT INTO memory_entry_source_refs (entry_id, organization_id, source_ref)
		SELECT e.id, e.organization_id, r
		  FROM memory_entries e, unnest($2::text[]) AS r
		 WHERE e.id = $1
		ON CONFLICT DO NOTHING`, entryID, refs)
	return err
}

// SourceRefsOf lists an entry's refs, for tests and diagnostics.
func (s *Store) SourceRefsOf(ctx context.Context, entryID string) ([]string, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT source_ref FROM memory_entry_source_refs WHERE entry_id = $1 ORDER BY source_ref`, entryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ForgottenEntry is what DeleteEntriesBySourceRef removed, so the caller
// can finish the cold-side cleanup.
type ForgottenEntry struct {
	ID        string
	Namespace string
	ProjectID *string
}

// DeleteEntriesBySourceRef deletes, in ONE transaction, every entry that
// carries ref, belongs to the caller's organization, and is inside the
// caller's scope — the same boundary forget-by-id uses: with projectID
// set the project is the boundary (members may be different users),
// otherwise only the caller's own user-wide entries. The delete covers
// the FTS shadow, access counters, relations and the entry itself (refs
// go by ON DELETE CASCADE), exactly as DeleteEntry does per id.
//
// Either every matching entry is gone or none is: a crash cannot leave a
// revoked entry retrievable next to a deleted sibling. The entries are
// locked FOR UPDATE first so a concurrent writer cannot merge the ref
// into an entry between the select and the delete.
//
// An empty result is not an error: forgetting is idempotent.
func (s *Store) DeleteEntriesBySourceRef(ctx context.Context, userID string, projectID *string, ref string) ([]ForgottenEntry, error) {
	org := tenant.OrgOf(userID)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx, `
		SELECT e.id, e.namespace, e.project_id
		  FROM memory_entries e
		 WHERE e.organization_id = $1
		   AND (($3::text IS NULL AND e.user_id = $2 AND e.project_id IS NULL)
		     OR ($3::text IS NOT NULL AND e.project_id = $3))
		   AND EXISTS (SELECT 1 FROM memory_entry_source_refs r
		                WHERE r.entry_id = e.id
		                  AND r.organization_id = $1
		                  AND r.source_ref = $4)
		 ORDER BY e.id
		   FOR UPDATE OF e`, org, userID, projectID, ref)
	if err != nil {
		return nil, err
	}
	var out []ForgottenEntry
	var ids []string
	for rows.Next() {
		var f ForgottenEntry
		if err := rows.Scan(&f.ID, &f.Namespace, &f.ProjectID); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, f)
		ids = append(ids, f.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	for _, stmt := range []string{
		`DELETE FROM memory_fts WHERE entry_id = ANY($1::text[])`,
		`DELETE FROM memory_access WHERE entry_id = ANY($1::text[])`,
		`DELETE FROM memory_relations WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[])`,
		`DELETE FROM memory_entries WHERE id = ANY($1::text[])`,
	} {
		if _, err := tx.Exec(ctx, stmt, ids); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
