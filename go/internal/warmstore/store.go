// Store is the Postgres warm tier. Transcribed from
// packages/server/src/warm-store/index.ts (read-only reference, never
// imported). Drizzle still owns the schema (migrations.go); this file
// only queries it.
package warmstore

import (
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SystemUser is the synthetic owner id in auth.mode none|bearer
// (warm-store/index.ts SYSTEM_USER).
const SystemUser = "public"

type Store struct {
	Pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{Pool: pool} }

// Entry mirrors the memory_entries columns the data plane reads
// (schema.ts memoryEntries).
type Entry struct {
	ID           string
	UserID       string
	ProjectID    *string
	Content      string
	Namespace    string
	Source       string
	AgentName    *string
	Metadata     map[string]any
	Cold         bool
	SourceType   *string
	CapturedFrom *string
	Confidence   float64
	ContentHash  *string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const entryColumns = `id, user_id, project_id, content, namespace, source, agent_name,
	metadata, cold, source_type, captured_from, confidence, content_hash, created_at, updated_at`

// scanEntry matches entryColumns order.
type rowScanner interface{ Scan(dest ...any) error }

func scanEntry(r rowScanner) (*Entry, error) {
	var e Entry
	err := r.Scan(&e.ID, &e.UserID, &e.ProjectID, &e.Content, &e.Namespace, &e.Source,
		&e.AgentName, &e.Metadata, &e.Cold, &e.SourceType, &e.CapturedFrom, &e.Confidence,
		&e.ContentHash, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if e.Metadata == nil {
		e.Metadata = map[string]any{}
	}
	return &e, nil
}
