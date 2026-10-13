package warmstore

import (
	"context"

	"github.com/azrtydxb/novamem/go/internal/tenant"
)

// DerivedEntry is a row the fact extractor produced from a source chunk,
// identified by its metadata.source_chunk_id back-link.
type DerivedEntry struct {
	ID        string
	Namespace string
	ProjectID *string
}

// DeleteDerivedFacts removes every entry derived from sourceID and
// returns what it deleted, so the caller can drop the matching cold
// vectors.
//
// Derived rows outlive their source otherwise: nothing else follows the
// back-link, so an edited source keeps being contradicted by facts
// distilled from its old wording, and a deleted one keeps being
// answered for by facts nobody can see or remove. Both were observable
// through search, where a derived row frequently outranks its own
// source.
//
// Scope: the project is the boundary when one is given, otherwise the
// user. Facts are stored under the user who WROTE the source, so a
// project member forgetting a colleague's entry must still reach the
// colleague's facts; filtering on the forgetter's user_id there would
// leave them behind, answering for an entry that no longer exists. The
// caller's organization always applies, and the back-link is the source
// entry's id, so a project-wide match can only ever be that entry's
// own facts.
func (s *Store) DeleteDerivedFacts(ctx context.Context, userID, sourceID string, projectID *string) ([]DerivedEntry, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx, `
		SELECT id, namespace, project_id
		  FROM memory_entries
		 WHERE organization_id = $4
		   AND metadata->>'source_chunk_id' = $2
		   AND (($3::text IS NULL AND user_id = $1)
		     OR ($3::text IS NOT NULL AND project_id = $3))
		   AND id <> $2
		   FOR UPDATE`,
		userID, sourceID, projectID, tenant.OrgOf(userID))
	if err != nil {
		return nil, err
	}
	var out []DerivedEntry
	var ids []string
	for rows.Next() {
		var d DerivedEntry
		if err := rows.Scan(&d.ID, &d.Namespace, &d.ProjectID); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, d)
		ids = append(ids, d.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, tx.Commit(ctx)
	}

	// The same shadow tables DeleteEntry clears, in the same order and
	// one transaction. memory_fts is the one that bites if skipped:
	// keyword search reads it, so an orphaned row keeps returning an id
	// whose entry is gone.
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
