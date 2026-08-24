// One-shot Qdrant → pgvector migration. Copies vectors as-is (no
// re-embedding, no LLM), resolving each point's namespace/scope from its
// warm row; Qdrant points whose warm row is gone are skipped as orphans.
//
// Fast-load pattern: per-partition HNSW indexes are DROPPED first, rows
// stream in via batched multi-row INSERTs against bare heaps, and the
// indexes are rebuilt once at the end under a large maintenance_work_mem.
// Incremental HNSW insertion measured ~5k rows/min at 260k vectors; this
// pattern loads the same data in a few minutes.
//
//	NOVAMEM_WARM_URL=postgres://... QDRANT_URL=http://qdrant:6333 \
//	  sync-qdrant-to-pgvector [--partitions 32]
//
// Idempotent: ON CONFLICT DO NOTHING, and the index rebuild uses IF NOT
// EXISTS after a drop, so a crashed run can simply be re-run.
//
// Ported from scripts/sync-qdrant-to-pgvector.mjs — the Go server's own
// pgvector remediation message points operators here, so it must not
// require a Node runtime.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const scrollLimit = 512

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "sync-qdrant-to-pgvector:", err)
		os.Exit(1)
	}
}

func run() error {
	partitions := flag.Int("partitions", 32, "number of memory_vectors_pN partitions")
	flag.Parse()

	warmURL := os.Getenv("NOVAMEM_WARM_URL")
	if warmURL == "" {
		return fmt.Errorf("NOVAMEM_WARM_URL is required")
	}
	qd := os.Getenv("QDRANT_URL")
	if qd == "" {
		qd = "http://localhost:6333"
	}
	q := &qdrant{
		base: strings.TrimSuffix(qd, "/"),
		// The server reads the same variable for its own Qdrant client,
		// so a deployment with a secured Qdrant needs no extra config to
		// run this tool.
		apiKey: os.Getenv("NOVAMEM_COLD_API_KEY"),
		client: &http.Client{Timeout: 60 * time.Second},
	}

	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(warmURL)
	if err != nil {
		return err
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()

	start := time.Now()
	fmt.Println("dropping per-partition HNSW indexes for fast load...")
	for i := 0; i < *partitions; i++ {
		if _, err := pool.Exec(ctx, fmt.Sprintf("DROP INDEX IF EXISTS idx_vectors_hnsw_p%d", i)); err != nil {
			return fmt.Errorf("drop index p%d: %w", i, err)
		}
	}

	collections, err := q.collections(ctx)
	if err != nil {
		return err
	}
	copied, orphans := 0, 0
	for _, col := range collections {
		var offset json.RawMessage
		for {
			points, next, err := q.scroll(ctx, col, offset)
			if err != nil {
				return fmt.Errorf("scroll %s: %w", col, err)
			}
			if len(points) == 0 {
				break
			}
			c, o, err := copyBatch(ctx, pool, points)
			if err != nil {
				return fmt.Errorf("copy batch from %s: %w", col, err)
			}
			copied += c
			orphans += o
			if next == nil {
				break
			}
			offset = next
		}
		fmt.Printf("  %s: cumulative %d copied, %d orphans\n", col, copied, orphans)
	}

	fmt.Printf("rows loaded in %ds; rebuilding HNSW indexes...\n", int(time.Since(start).Seconds()))
	if err := rebuildIndexes(ctx, pool, *partitions); err != nil {
		return err
	}
	fmt.Printf("DONE: %d vectors, %d orphans, %d collections, total %ds\n",
		copied, orphans, len(collections), int(time.Since(start).Seconds()))
	return nil
}

// warmRow is the entry metadata a vector needs to be placed correctly.
type warmRow struct {
	userID    string
	projectID *string
	namespace string
}

// copyBatch resolves one scroll page against memory_entries and inserts
// the points whose entry still exists. Points without a warm row are
// orphans: their entry was deleted while the vector outlived it.
func copyBatch(ctx context.Context, pool *pgxpool.Pool, points []point) (copied, orphans int, err error) {
	ids := make([]string, 0, len(points))
	for _, p := range points {
		if p.Payload.EntryID != "" {
			ids = append(ids, p.Payload.EntryID)
		}
	}
	meta := map[string]warmRow{}
	if len(ids) > 0 {
		rows, err := pool.Query(ctx,
			"SELECT id, user_id, project_id, namespace FROM memory_entries WHERE id = ANY($1)", ids)
		if err != nil {
			return 0, 0, err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var r warmRow
			if err := rows.Scan(&id, &r.userID, &r.projectID, &r.namespace); err != nil {
				return 0, 0, err
			}
			meta[id] = r
		}
		if err := rows.Err(); err != nil {
			return 0, 0, err
		}
	}

	var (
		placeholders []string
		params       []any
	)
	for _, p := range points {
		m, ok := meta[p.Payload.EntryID]
		if p.Payload.EntryID == "" || !ok {
			orphans++
			continue
		}
		scope := "u:" + m.userID
		if m.projectID != nil {
			scope = "p:" + *m.projectID
		}
		n := len(params)
		placeholders = append(placeholders, fmt.Sprintf("($%d, $%d, $%d, $%d, $%d, $%d::vector, $%d)",
			n+1, n+2, n+3, n+4, n+5, n+6, n+7))
		params = append(params, p.Payload.EntryID, m.userID, m.projectID, m.namespace,
			scope, vectorLiteral(p.Vector), string(p.RawPayload))
		copied++
	}
	if len(placeholders) == 0 {
		return copied, orphans, nil
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO memory_vectors (entry_id, user_id, project_id, namespace, scope, embedding, payload)
		 VALUES `+strings.Join(placeholders, ",")+
			` ON CONFLICT (entry_id, scope, namespace) DO NOTHING`, params...)
	if err != nil {
		return 0, 0, err
	}
	return copied, orphans, nil
}

// vectorLiteral renders pgvector's text input format.
func vectorLiteral(v []float64) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(f, 'g', -1, 64))
	}
	b.WriteByte(']')
	return b.String()
}

// rebuildIndexes runs on ONE dedicated connection: SET is per-session,
// and a pooled query may land on a different backend than the CREATE
// INDEX that depends on it.
func rebuildIndexes(ctx context.Context, pool *pgxpool.Pool, partitions int) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	// 256MB, sequential: partitions are small by design, and a bigger
	// value here OOM-killed a 2Gi-limit pod during the bench migration.
	if _, err := conn.Exec(ctx, "SET maintenance_work_mem = '256MB'"); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, "SET max_parallel_maintenance_workers = 0"); err != nil {
		return err
	}
	for i := 0; i < partitions; i++ {
		t := time.Now()
		stmt := fmt.Sprintf(
			`CREATE INDEX IF NOT EXISTS idx_vectors_hnsw_p%d ON memory_vectors_p%d USING hnsw (embedding vector_cosine_ops)`, i, i)
		if _, err := conn.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("build index p%d: %w", i, err)
		}
		fmt.Printf("  index p%d built in %ds\n", i, int(time.Since(t).Seconds()))
	}
	return nil
}

// --- Qdrant HTTP -----------------------------------------------------

type qdrant struct {
	base   string
	apiKey string
	client *http.Client
}

type point struct {
	Vector     []float64
	Payload    payload
	RawPayload json.RawMessage
}

type payload struct {
	EntryID string `json:"entryId"`
}

func (q *qdrant) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, q.base+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if q.apiKey != "" {
		req.Header.Set("api-key", q.apiKey)
	}
	res, err := q.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(res.Body, 256))
		return fmt.Errorf("qdrant %s %s: %s: %s", method, path, res.Status, strings.TrimSpace(string(snippet)))
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (q *qdrant) collections(ctx context.Context) ([]string, error) {
	var res struct {
		Result struct {
			Collections []struct {
				Name string `json:"name"`
			} `json:"collections"`
		} `json:"result"`
	}
	if err := q.do(ctx, http.MethodGet, "/collections", nil, &res); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(res.Result.Collections))
	for _, c := range res.Result.Collections {
		names = append(names, c.Name)
	}
	return names, nil
}

// scroll returns one page of points and the offset for the next, or nil
// when the collection is exhausted.
func (q *qdrant) scroll(ctx context.Context, collection string, offset json.RawMessage) ([]point, json.RawMessage, error) {
	body := map[string]any{
		"limit":        scrollLimit,
		"with_payload": true,
		"with_vector":  true,
	}
	if len(offset) > 0 {
		body["offset"] = offset
	}
	var res struct {
		Result struct {
			Points []struct {
				Vector  []float64       `json:"vector"`
				Payload json.RawMessage `json:"payload"`
			} `json:"points"`
			NextPageOffset json.RawMessage `json:"next_page_offset"`
		} `json:"result"`
	}
	path := "/collections/" + collection + "/points/scroll"
	if err := q.do(ctx, http.MethodPost, path, body, &res); err != nil {
		return nil, nil, err
	}
	points := make([]point, 0, len(res.Result.Points))
	for _, p := range res.Result.Points {
		pt := point{Vector: p.Vector, RawPayload: p.Payload}
		if len(p.Payload) == 0 {
			pt.RawPayload = json.RawMessage("{}")
		}
		_ = json.Unmarshal(pt.RawPayload, &pt.Payload) // entryId only; a payload without one is an orphan
		points = append(points, pt)
	}
	next := res.Result.NextPageOffset
	if len(next) == 0 || string(next) == "null" {
		next = nil
	}
	return points, next, nil
}
