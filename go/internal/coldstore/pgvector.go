// Package coldstore is the pgvector cold tier. Transcribed from
// packages/server/src/cold-store-pgvector.ts (read-only reference,
// never imported): same DDL (idempotent, hash-partitioned on
// (scope, namespace) with per-partition HNSW indexes), same scope rule
// (u:<user> / p:<project>), same SQL for upsert/search/existingIds/
// delete, same score clip at 0.
//
// The Qdrant backend lives in qdrant.go; both sit behind the Store façade
// in store.go.
package coldstore

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

const table = "memory_vectors"

// Hash-partition count — fixed after first creation (cold-store-pgvector.ts
// PARTITIONS). 32 keeps each partition's HNSW graph small through the
// multi-million-vector range.
const partitions = 32

type Config struct {
	// Postgres connection string — usually the warm store's own database.
	URL string
	// Embedding dimensionality — becomes the vector column's type. A
	// mismatch against an existing table fails loudly.
	VectorSize int
	// Statement timeout / per-request timeout; default 15s
	// (TS statement_timeout, and the Qdrant client's ms `timeout`).
	TimeoutMs int
	// Qdrant api-key header (NOVAMEM_COLD_API_KEY). Unset — the TS
	// server's only mode — sends no header at all.
	APIKey string
}

type pgStore struct {
	pool *pgxpool.Pool
	dim  int

	// ensureReady memo. A failed attempt must not be cached forever
	// (cold-store-pgvector.ts: sticky rejected promise kept pods
	// unready through a postgres crashloop) — ready is reset on error.
	mu    sync.Mutex
	ready bool
}

func newPgvector(ctx context.Context, cfg Config) (*pgStore, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("cold store url: %w", err)
	}
	timeoutMs := cfg.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 15_000
	}
	// TS Pool max: 10 — the cold pgvector pool is deliberately NOT tied to
	// NOVAMEM_PG_POOL_MAX (cold-store-pgvector.ts hardcodes it; only the
	// warm pool reads config.service.pgPoolMax).
	poolCfg.MaxConns = 10
	poolCfg.ConnConfig.RuntimeParams["statement_timeout"] = strconv.Itoa(timeoutMs)
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, err
	}
	return &pgStore{pool: pool, dim: cfg.VectorSize}, nil
}

// VectorLiteral formats an embedding as a pgvector input literal
// ("[1,2,3]") — cold-store-pgvector.ts toVectorLiteral.
func VectorLiteral(embedding []float64) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range embedding {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(f, 'g', -1, 64))
	}
	b.WriteByte(']')
	return b.String()
}

// ScopeOf — same scope rule as the TS store (and the Qdrant collection
// naming): a project-scoped entry lives under its project (user
// deliberately not part of the key — members share the space); a user
// entry lives under (user, no project). This is the partition key, so
// matching on scope is what lets the planner prune to one partition.
func ScopeOf(userID string, projectID *string) string {
	if projectID == nil {
		return "u:" + userID
	}
	return "p:" + *projectID
}

// ensureReady — idempotent DDL, run once per process on first use
// (cold-store-pgvector.ts ensureReady, ported statement-for-statement).
// The same CREATE IF NOT EXISTS pattern the TS server itself runs
// outside drizzle, so the Go server can bootstrap a fresh database AND
// run against one the TS server already prepared.
func (s *pgStore) ensureReady(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ready {
		return nil
	}
	if err := s.ensureReadyLocked(ctx); err != nil {
		return err
	}
	s.ready = true
	return nil
}

func (s *pgStore) ensureReadyLocked(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS vector"); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			entry_id   TEXT NOT NULL,
			user_id    TEXT NOT NULL,
			project_id TEXT,
			namespace  TEXT NOT NULL,
			scope      TEXT NOT NULL,
			embedding  vector(%d) NOT NULL,
			payload    JSONB NOT NULL DEFAULT '{}',
			PRIMARY KEY (entry_id, scope, namespace)
		) PARTITION BY HASH (scope, namespace)`, table, s.dim)); err != nil {
		return err
	}
	for i := 0; i < partitions; i++ {
		if _, err := s.pool.Exec(ctx, fmt.Sprintf(
			`CREATE TABLE IF NOT EXISTS %s_p%d PARTITION OF %s
			 FOR VALUES WITH (MODULUS %d, REMAINDER %d)`, table, i, table, partitions, i)); err != nil {
			return err
		}
	}
	// Dimensionality guard: a mismatch against an existing table fails
	// loudly rather than truncating or padding.
	var existing *int
	if err := s.pool.QueryRow(ctx, fmt.Sprintf(
		`SELECT atttypmod AS dim FROM pg_attribute
		 WHERE attrelid = '%s'::regclass AND attname = 'embedding'`, table)).Scan(&existing); err == nil {
		if existing != nil && *existing > 0 && *existing != s.dim {
			return fmt.Errorf(
				"%s.embedding is vector(%d) but NOVAMEM_COLD_VECTOR_SIZE=%d — refusing to mix dimensionalities; migrate or re-embed first",
				table, *existing, s.dim)
		}
	}
	// PK guard: a table from an earlier build (PK without namespace)
	// fails upserts with an opaque ON CONFLICT error — detect at startup
	// and say what to actually do (cold-store-pgvector.ts).
	var pkCols *string
	if err := s.pool.QueryRow(ctx, fmt.Sprintf(
		`SELECT string_agg(a.attname, ',' ORDER BY x.n) AS cols
		 FROM pg_index i
		 JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, n) ON true
		 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
		 WHERE i.indrelid = '%s'::regclass AND i.indisprimary`, table)).Scan(&pkCols); err != nil {
		return err
	}
	if pkCols != nil && *pkCols != "" && *pkCols != "entry_id,scope,namespace" {
		return fmt.Errorf(
			"%s has primary key (%s) from an older build; this version requires (entry_id, scope, namespace). "+
				"Rebuild the table: DROP TABLE %s, restart to recreate, then re-run "+
				"go run ./cmd/sync-qdrant-to-pgvector (or re-embed)",
			table, strings.Join(strings.Split(*pkCols, ","), ", "), table)
	}
	// Partitioned parents can't carry an HNSW index; each partition gets
	// its own (that is the point).
	for i := 0; i < partitions; i++ {
		if _, err := s.pool.Exec(ctx, fmt.Sprintf(
			`CREATE INDEX IF NOT EXISTS idx_vectors_hnsw_p%d ON %s_p%d
			 USING hnsw (embedding vector_cosine_ops)`, i, table, i)); err != nil {
			return err
		}
	}
	if _, err := s.pool.Exec(ctx, fmt.Sprintf(
		`CREATE INDEX IF NOT EXISTS idx_vectors_scope ON %s (scope, namespace)`, table)); err != nil {
		return err
	}
	return nil
}

type UpsertArgs struct {
	UserID    string
	ProjectID *string
	ID        string
	Namespace string
	Embedding []float64
	Payload   map[string]any
}

func (s *pgStore) Upsert(ctx context.Context, a UpsertArgs) error {
	if err := s.ensureReady(ctx); err != nil {
		return err
	}
	// Payload rides with entryId/userId/projectId stamped in, exactly
	// like the TS store spreads them over the caller's payload.
	payload := map[string]any{}
	for k, v := range a.Payload {
		payload[k] = v
	}
	payload["entryId"] = a.ID
	payload["userId"] = a.UserID
	if a.ProjectID != nil {
		payload["projectId"] = *a.ProjectID
	} else {
		payload["projectId"] = nil
	}
	_, err := s.pool.Exec(ctx, fmt.Sprintf(`
		INSERT INTO %s (entry_id, user_id, project_id, namespace, scope, embedding, payload)
		VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
		ON CONFLICT (entry_id, scope, namespace) DO UPDATE SET
			user_id = EXCLUDED.user_id, project_id = EXCLUDED.project_id,
			namespace = EXCLUDED.namespace, embedding = EXCLUDED.embedding,
			payload = EXCLUDED.payload`, table),
		a.ID, a.UserID, a.ProjectID, a.Namespace, ScopeOf(a.UserID, a.ProjectID),
		VectorLiteral(a.Embedding), payload)
	return err
}

type Hit struct {
	ID      string
	Score   float64
	Payload map[string]any
}

type SearchArgs struct {
	UserID    string
	ProjectID *string
	Namespace string
	Embedding []float64
	K         int
}

func (s *pgStore) Search(ctx context.Context, a SearchArgs) ([]Hit, error) {
	if err := s.ensureReady(ctx); err != nil {
		return nil, err
	}
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// pgvector >= 0.8: keep walking the graph until enough rows survive
	// the WHERE filter (the filtered-ANN recall trap). Older versions
	// have no such GUC — the SET fails and is ignored, exactly as the TS
	// store does. NOTE: like the TS code, this assumes a failed SET does
	// not abort the transaction (true when "hnsw" is an unreserved
	// custom-GUC prefix); the parity gate against real pgvector decides
	// whether that assumption holds, not this comment.
	_, _ = tx.Exec(ctx, "SET LOCAL hnsw.iterative_scan = relaxed_order")
	vec := VectorLiteral(a.Embedding)
	rows, err := tx.Query(ctx, fmt.Sprintf(`
		SELECT entry_id, payload, 1 - (embedding <=> $2::vector) AS score
		FROM %s
		WHERE scope = $1 AND namespace = $3
		ORDER BY embedding <=> $2::vector
		LIMIT $4`, table),
		ScopeOf(a.UserID, a.ProjectID), vec, a.Namespace, a.K)
	if err != nil {
		return nil, err
	}
	var out []Hit
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.ID, &h.Payload, &h.Score); err != nil {
			rows.Close()
			return nil, err
		}
		// Same clip as the Qdrant store: a negative cosine means "points
		// apart" and must not contribute negative weight.
		if h.Score < 0 {
			h.Score = 0
		}
		if h.Payload == nil {
			h.Payload = map[string]any{}
		}
		out = append(out, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

type EntryRef struct {
	ID        string
	UserID    string
	ProjectID *string
	Namespace string
}

// ExistingIds — which of the given entries already have a vector, with
// full scope discipline (an id under a DIFFERENT tenant/namespace must
// not count). One grouped query via a VALUES join.
func (s *pgStore) ExistingIds(ctx context.Context, entries []EntryRef) (map[string]bool, error) {
	if err := s.ensureReady(ctx); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	if len(entries) == 0 {
		return out, nil
	}
	values := make([]string, 0, len(entries))
	params := make([]any, 0, len(entries)*3)
	for i, e := range entries {
		b := i * 3
		values = append(values, fmt.Sprintf("($%d, $%d, $%d)", b+1, b+2, b+3))
		params = append(params, e.ID, ScopeOf(e.UserID, e.ProjectID), e.Namespace)
	}
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT v.id FROM (VALUES %s) AS v(id, scope, namespace)
		JOIN %s t ON t.entry_id = v.id
		 AND t.scope = v.scope
		 AND t.namespace = v.namespace`, strings.Join(values, ","), table), params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// Delete — namespace is part of the scope exactly as in Search: knowing
// an id must not be enough to delete across shelves.
func (s *pgStore) Delete(ctx context.Context, userID, namespace, id string, projectID *string) error {
	if err := s.ensureReady(ctx); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, fmt.Sprintf(`
		DELETE FROM %s
		WHERE entry_id = $2 AND namespace = $3 AND scope = $1`, table),
		ScopeOf(userID, projectID), id, namespace)
	return err
}

// DeleteAllForUser removes EVERY vector the user owns, in any scope —
// including rows they wrote into other users' projects.
func (s *pgStore) DeleteAllForUser(ctx context.Context, userID string) ([]string, error) {
	if err := s.ensureReady(ctx); err != nil {
		return nil, err
	}
	tag, err := s.pool.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE user_id = $1`, table), userID)
	if err != nil {
		return nil, err
	}
	return []string{fmt.Sprintf("%s: %d vectors removed for user %s", table, tag.RowsAffected(), userID)}, nil
}

func (s *pgStore) DeleteAllForProject(ctx context.Context, projectID string) ([]string, error) {
	if err := s.ensureReady(ctx); err != nil {
		return nil, err
	}
	tag, err := s.pool.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE project_id = $1`, table), projectID)
	if err != nil {
		return nil, err
	}
	// Row count in the same string[] shape the Qdrant store's dropped
	// collection names use, for wire compatibility.
	return []string{fmt.Sprintf("%s: %d vectors removed for project %s", table, tag.RowsAffected(), projectID)}, nil
}

func (s *pgStore) Ping(ctx context.Context) bool {
	if err := s.ensureReady(ctx); err != nil {
		return false
	}
	var one int
	return s.pool.QueryRow(ctx, "SELECT 1").Scan(&one) == nil
}

func (s *pgStore) Close() { s.pool.Close() }

func (*pgStore) Provider() string { return "pgvector" }
