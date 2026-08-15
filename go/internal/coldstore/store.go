package coldstore

import "context"

// backend is the surface both cold tiers implement. Store is a thin
// façade over it so callers (engine.Options.Cold) keep taking one
// concrete *coldstore.Store regardless of which provider is configured.
type backend interface {
	Upsert(ctx context.Context, a UpsertArgs) error
	Search(ctx context.Context, a SearchArgs) ([]Hit, error)
	ExistingIds(ctx context.Context, entries []EntryRef) (map[string]bool, error)
	Delete(ctx context.Context, userID, namespace, id string, projectID *string) error
	DeleteAllForUser(ctx context.Context, userID string) ([]string, error)
	DeleteAllForProject(ctx context.Context, projectID string) ([]string, error)
	Ping(ctx context.Context) bool
	// Provider names the backend for operators — the dashboard's health
	// page used to hardcode "qdrant" regardless of what was configured,
	// which told a pgvector deployment it was running Qdrant.
	Provider() string
	Close()
}

// Store is the cold tier. Method set comes from the embedded backend.
type Store struct{ backend }

// New builds the pgvector-backed cold store.
func New(ctx context.Context, cfg Config) (*Store, error) {
	b, err := newPgvector(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Store{backend: b}, nil
}

// NewQdrant builds the Qdrant-backed cold store. No connection is made
// here — the TS client is lazy too, and collections are created on first
// write.
func NewQdrant(cfg Config) *Store { return &Store{backend: newQdrant(cfg)} }
