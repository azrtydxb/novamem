// Qdrant cold tier. Transcribed from packages/server/src/cold-store.ts
// (read-only reference, never imported): same collection naming, the
// same legacy-collection read/delete union (issue #20), the same point-id
// derivation, the same retry rule on upsert, the same score clip, and the
// same fatal-vs-logged split on failures.
//
// Talks the Qdrant REST API directly with net/http. The TS client
// (@qdrant/js-client-rest) is itself a thin REST wrapper, so there is
// nothing to gain from a Go SDK dependency.
package coldstore

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// pointID derives a deterministic UUID-shaped string from any id. Qdrant
// point ids must be unsigned ints or UUIDs — our ULIDs are neither. The
// original id is preserved in the payload as `entryId` (cold-store.ts
// ulidToUuid).
func pointID(id string) string {
	sum := sha1.Sum([]byte(id))
	h := hex.EncodeToString(sum[:])[:32]
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

type qdrantError struct {
	status int
	body   string
}

func (e *qdrantError) Error() string {
	return fmt.Sprintf("qdrant %d: %s", e.status, strings.TrimSpace(e.body))
}

// cold-store.ts isCollectionAlreadyExistsError.
func isCollectionAlreadyExists(err error) bool {
	qe, ok := err.(*qdrantError)
	if !ok {
		return false
	}
	if qe.status == 409 {
		return true
	}
	m := strings.ToLower(qe.body)
	return strings.Contains(m, "collection") && strings.Contains(m, "already exists")
}

// cold-store.ts isRetryableQdrantUpsertError: only a 500 whose body says
// the operation failed to apply and asks for a retry.
func isRetryableUpsertError(err error) bool {
	qe, ok := err.(*qdrantError)
	if !ok || qe.status != 500 {
		return false
	}
	m := strings.ToLower(qe.body)
	return strings.Contains(m, "failed to apply operation") && strings.Contains(m, "please retry")
}

type qdrantStore struct {
	url    string
	apiKey string
	dim    int
	http   *http.Client

	mu   sync.Mutex
	seen map[string]bool // collections observed to exist
}

func newQdrant(cfg Config) *qdrantStore {
	timeoutMs := cfg.TimeoutMs
	if timeoutMs == 0 {
		// cold-store.ts: the client constructor's `timeout` is ms, default 15s.
		timeoutMs = 15_000
	}
	return &qdrantStore{
		url:    strings.TrimRight(cfg.URL, "/"),
		apiKey: cfg.APIKey,
		dim:    cfg.VectorSize,
		http:   &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond},
		seen:   map[string]bool{},
	}
}

// do issues one REST call. `out`, when non-nil, receives the decoded
// `result` field of the Qdrant envelope.
func (s *qdrantStore) do(ctx context.Context, method, path string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.url+path, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if s.apiKey != "" {
		req.Header.Set("api-key", s.apiKey)
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &qdrantError{status: resp.StatusCode, body: string(raw)}
	}
	if out == nil {
		return nil
	}
	var env struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if len(env.Result) == 0 {
		return nil
	}
	return json.Unmarshal(env.Result, out)
}

/*
collectionFor — collection naming embeds user + project so vector leakage
is structurally impossible:

  - user-wide entries (no project): novamem_u_<user>_<namespace>
  - project-scoped entries:          novamem_p_<project>_<namespace>

Both lead with a kind prefix so a user id can never collide with a
project id. Project membership is cross-user by design, so the user id
intentionally does not appear in project-scoped names.
*/
func collectionFor(userID, namespace string, projectID *string) string {
	if projectID != nil {
		return "novamem_p_" + *projectID + "_" + namespace
	}
	return "novamem_u_" + userID + "_" + namespace
}

// legacyUserCollectionFor — the pre-issue-#20 unprefixed name. Read/delete
// fallback only; never written to.
func legacyUserCollectionFor(userID, namespace string) string {
	return "novamem_" + userID + "_" + namespace
}

func (s *qdrantStore) listCollections(ctx context.Context) (map[string]bool, error) {
	var res struct {
		Collections []struct {
			Name string `json:"name"`
		} `json:"collections"`
	}
	if err := s.do(ctx, http.MethodGet, "/collections", nil, &res); err != nil {
		return nil, err
	}
	names := make(map[string]bool, len(res.Collections))
	for _, c := range res.Collections {
		names[c.Name] = true
	}
	return names, nil
}

// resolveReadCollections returns every collection that may hold vectors
// for this scope — the prefixed one AND, for user scope, the legacy one,
// *both* when both exist. Empty slice when nothing exists yet, so a pure
// read never creates an empty collection (cold-store.ts).
func (s *qdrantStore) resolveReadCollections(ctx context.Context, userID, namespace string, projectID *string) ([]string, error) {
	primary := collectionFor(userID, namespace, projectID)
	legacy := ""
	if projectID == nil {
		legacy = legacyUserCollectionFor(userID, namespace)
	}
	s.mu.Lock()
	if s.seen[primary] && (legacy == "" || s.seen[legacy]) {
		s.mu.Unlock()
		if legacy != "" {
			return []string{primary, legacy}, nil
		}
		return []string{primary}, nil
	}
	s.mu.Unlock()

	names, err := s.listCollections(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	s.mu.Lock()
	defer s.mu.Unlock()
	if names[primary] {
		s.seen[primary] = true
		out = append(out, primary)
	}
	if legacy != "" && names[legacy] {
		s.seen[legacy] = true
		out = append(out, legacy)
	}
	return out, nil
}

func (s *qdrantStore) ensureCollection(ctx context.Context, userID, namespace string, projectID *string) error {
	name := collectionFor(userID, namespace, projectID)
	s.mu.Lock()
	known := s.seen[name]
	s.mu.Unlock()
	if known {
		return nil
	}
	names, err := s.listCollections(ctx)
	if err != nil {
		return err
	}
	if !names[name] {
		body := map[string]any{
			"vectors": map[string]any{"size": s.dim, "distance": "Cosine"},
		}
		// Concurrent first writes can both observe a missing collection;
		// Qdrant returns 409 to the loser. The collection exists at that
		// point, so the writer proceeds. Every other failure is preserved.
		if err := s.do(ctx, http.MethodPut, "/collections/"+name, body, nil); err != nil && !isCollectionAlreadyExists(err) {
			return err
		}
	}
	s.mu.Lock()
	s.seen[name] = true
	s.mu.Unlock()
	return nil
}

func (s *qdrantStore) Upsert(ctx context.Context, a UpsertArgs) error {
	if err := s.ensureCollection(ctx, a.UserID, a.Namespace, a.ProjectID); err != nil {
		return err
	}
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
	body := map[string]any{"points": []any{map[string]any{
		"id":      pointID(a.ID),
		"vector":  a.Embedding,
		"payload": payload,
	}}}
	path := "/collections/" + collectionFor(a.UserID, a.Namespace, a.ProjectID) + "/points"
	for attempt := 1; ; attempt++ {
		err := s.do(ctx, http.MethodPut, path, body, nil)
		if err == nil {
			return nil
		}
		if attempt >= 8 || !isRetryableUpsertError(err) {
			return err
		}
		backoff := 50 * time.Millisecond << (attempt - 1)
		if backoff > time.Second {
			backoff = time.Second
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
	}
}

type qdrantPoint struct {
	ID      any            `json:"id"`
	Score   float64        `json:"score"`
	Payload map[string]any `json:"payload"`
}

// entryID resolves the caller-visible id: the payload's `entryId` when
// present, else the raw point id.
func (p qdrantPoint) entryID() string {
	if v, ok := p.Payload["entryId"].(string); ok {
		return v
	}
	return fmt.Sprint(p.ID)
}

func (s *qdrantStore) Search(ctx context.Context, a SearchArgs) ([]Hit, error) {
	collections, err := s.resolveReadCollections(ctx, a.UserID, a.Namespace, a.ProjectID)
	if err != nil {
		return nil, err
	}
	if len(collections) == 0 {
		return nil, nil
	}
	// Query API (not the removed `search()`): a raw vector as `query` is a
	// plain nearest-neighbour lookup.
	body := map[string]any{"query": a.Embedding, "limit": a.K, "with_payload": true}
	// Merge by resolved entry id keeping the best score, THEN sort and
	// re-apply k — deduplicating before the slice is load-bearing while a
	// primary and a legacy collection both hold the same entry.
	best := map[string]Hit{}
	for _, c := range collections {
		var res struct {
			Points []qdrantPoint `json:"points"`
		}
		if err := s.do(ctx, http.MethodPost, "/collections/"+c+"/points/query", body, &res); err != nil {
			return nil, err
		}
		for _, p := range res.Points {
			payload := p.Payload
			if payload == nil {
				payload = map[string]any{}
			}
			// Cosine ranges over [-1,1]; a negative score means the vectors
			// point apart. Clip to 0 so a near-orthogonal hit contributes
			// nothing rather than a negative weight.
			score := p.Score
			if score < 0 {
				score = 0
			}
			id := p.entryID()
			if prev, ok := best[id]; !ok || score > prev.Score {
				best[id] = Hit{ID: id, Score: score, Payload: payload}
			}
		}
	}
	out := make([]Hit, 0, len(best))
	for _, h := range best {
		out = append(out, h)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > a.K {
		out = out[:a.K]
	}
	return out, nil
}

// ExistingIds — which requested warm entry ids still have a vector.
// Grouped by collection to avoid one request per entry (cold-store.ts).
func (s *qdrantStore) ExistingIds(ctx context.Context, entries []EntryRef) (map[string]bool, error) {
	out := map[string]bool{}
	groups := map[string][]EntryRef{}
	var order []string
	for _, e := range entries {
		collections, err := s.resolveReadCollections(ctx, e.UserID, e.Namespace, e.ProjectID)
		if err != nil {
			return nil, err
		}
		for _, c := range collections {
			if _, ok := groups[c]; !ok {
				order = append(order, c)
			}
			groups[c] = append(groups[c], e)
		}
	}
	for _, c := range order {
		ids := make([]string, 0, len(groups[c]))
		for _, e := range groups[c] {
			ids = append(ids, pointID(e.ID))
		}
		var points []qdrantPoint
		body := map[string]any{"ids": ids, "with_payload": true, "with_vector": false}
		if err := s.do(ctx, http.MethodPost, "/collections/"+c+"/points", body, &points); err != nil {
			return nil, err
		}
		for _, p := range points {
			if v, ok := p.Payload["entryId"].(string); ok {
				out[v] = true
			}
		}
	}
	return out, nil
}

// Delete removes the point from EVERY collection that could hold it — the
// prefixed form and the legacy one. Deleting an absent point is a no-op in
// Qdrant, so the extra call is harmless.
func (s *qdrantStore) Delete(ctx context.Context, userID, namespace, id string, projectID *string) error {
	collections, err := s.resolveReadCollections(ctx, userID, namespace, projectID)
	if err != nil {
		return err
	}
	body := map[string]any{"points": []string{pointID(id)}}
	for _, c := range collections {
		if err := s.do(ctx, http.MethodPost, "/collections/"+c+"/points/delete", body, nil); err != nil {
			return err
		}
	}
	return nil
}

// dropPrefix — best-effort prefix scan + drop. Individual failures are
// logged and skipped (cold-store.ts deleteAllFor*), a failure to LIST is
// fatal.
func (s *qdrantStore) dropPrefix(ctx context.Context, prefix string) ([]string, error) {
	names, err := s.listCollections(ctx)
	if err != nil {
		return nil, err
	}
	mine := make([]string, 0, len(names))
	for n := range names {
		if strings.HasPrefix(n, prefix) {
			mine = append(mine, n)
		}
	}
	sort.Strings(mine)
	var dropped []string
	for _, name := range mine {
		if err := s.do(ctx, http.MethodDelete, "/collections/"+name, nil, nil); err != nil {
			slog.Warn(fmt.Sprintf("[cold-store] deleteCollection(%s) failed: %v", name, err))
			continue
		}
		s.mu.Lock()
		delete(s.seen, name)
		s.mu.Unlock()
		dropped = append(dropped, name)
	}
	return dropped, nil
}

// DeleteAllForUser drops every user-wide collection. Project collections
// die with their project; vectors this user wrote into OTHER users'
// projects are per-point rows this collection-level API cannot reach —
// the warm teardown parks those ids in cold_orphans for the reaper.
func (s *qdrantStore) DeleteAllForUser(ctx context.Context, userID string) ([]string, error) {
	return s.dropPrefix(ctx, "novamem_u_"+userID+"_")
}

func (s *qdrantStore) DeleteAllForProject(ctx context.Context, projectID string) ([]string, error) {
	return s.dropPrefix(ctx, "novamem_p_"+projectID+"_")
}

func (s *qdrantStore) Ping(ctx context.Context) bool {
	if _, err := s.listCollections(ctx); err != nil {
		slog.Warn(fmt.Sprintf("[cold-store] ping failed: %v", err))
		return false
	}
	return true
}

func (s *qdrantStore) Close() { s.http.CloseIdleConnections() }
