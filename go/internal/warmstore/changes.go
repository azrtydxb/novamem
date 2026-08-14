// Changelog appends. Transcribed from warm-store/index.ts recordChanges:
// BEST-EFFORT BY CONTRACT — callers must never fail a mutation because
// the log insert failed (the engine logs a warning and moves on).
package warmstore

import "context"

type ChangeRow struct {
	UserID    string
	ProjectID *string
	EntryID   string
	Change    string // created | updated | superseded | deleted | expired
	Detail    map[string]any
}

func (s *Store) RecordChanges(ctx context.Context, rows []ChangeRow) error {
	if len(rows) == 0 {
		return nil
	}
	// The engine only ever appends one row per mutation; a loop keeps this
	// boring rather than building a multi-VALUES statement for n=1.
	for _, r := range rows {
		if _, err := s.Pool.Exec(ctx, `
			INSERT INTO memory_changes (user_id, project_id, entry_id, change, detail)
			VALUES ($1,$2,$3,$4,$5)`,
			r.UserID, r.ProjectID, r.EntryID, r.Change, r.Detail); err != nil {
			return err
		}
	}
	return nil
}
