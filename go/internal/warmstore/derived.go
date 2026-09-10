package warmstore

import "context"

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
// Scoped by user, and by project when one is given, so this can never
// reach across a scope boundary the caller did not already have.
func (s *Store) DeleteDerivedFacts(ctx context.Context, userID, sourceID string, projectID *string) ([]DerivedEntry, error) {
	rows, err := s.Pool.Query(ctx, `
		DELETE FROM memory_entries
		 WHERE user_id = $1
		   AND metadata->>'source_chunk_id' = $2
		   AND ($3::text IS NULL OR project_id = $3)
		   AND id <> $2
		RETURNING id, namespace, project_id`,
		userID, sourceID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DerivedEntry
	for rows.Next() {
		var d DerivedEntry
		if err := rows.Scan(&d.ID, &d.Namespace, &d.ProjectID); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
