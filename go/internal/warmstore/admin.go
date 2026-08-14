// Admin-plane and background-job queries: the user census and teardown,
// audit-log tail, token revoke, quota upsert, metrics-sample flush and
// the reconciler/decay work queues. Transcribed from
// packages/server/src/warm-store/index.ts (listUsers, listOwnedProjects,
// deleteUserData, listAuditLog, revokeUserToken, setUserQuota,
// recordMetricsSamples, pruneMetricsSamples, listPending*, count*,
// pruneChanges, get/setEngineState).
package warmstore

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/azrtydxb/novamem/go/internal/auth"
)

// UserRow is one row of GET /v1/admin/users.
type UserRow struct {
	ID         string  `json:"id"`
	Email      string  `json:"email"`
	Name       *string `json:"name"`
	Role       string  `json:"role"`
	CreatedAt  string  `json:"createdAt"`
	EntryCount int     `json:"entryCount"`
	TokenCount int     `json:"tokenCount"`
}

// ListUsers — every user with their footprint (entries + live tokens).
func (s *Store) ListUsers(ctx context.Context) ([]UserRow, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT u.id, u.email, u.name, u.role, u."createdAt",
		       (SELECT count(*) FROM memory_entries e WHERE e.user_id = u.id) AS entry_count,
		       (SELECT count(*) FROM user_tokens t
		         WHERE t.user_id = u.id AND t.revoked_at IS NULL
		           AND (t.expires_at IS NULL OR t.expires_at > now())) AS token_count
		  FROM "user" u
		 ORDER BY u."createdAt" ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserRow{}
	for rows.Next() {
		var u UserRow
		var role *string
		var created time.Time
		var entries, tokens int64
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &role, &created, &entries, &tokens); err != nil {
			return nil, err
		}
		u.Role = "user"
		if role != nil && *role != "" {
			u.Role = *role
		}
		u.CreatedAt = created.UTC().Format("2006-01-02T15:04:05.000Z")
		u.EntryCount, u.TokenCount = int(entries), int(tokens)
		out = append(out, u)
	}
	return out, rows.Err()
}

// ListOwnedProjects — the projects the engine must delete before the
// user row can go (deleting the owner first would orphan them).
func (s *Store) ListOwnedProjects(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id FROM projects WHERE owner_user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// DeleteUserData removes everything the warm store holds for a user in
// ONE transaction — a half-deleted user is worse than a present one.
// Owned projects must already be gone (the engine's job); this refuses
// otherwise.
func (s *Store) DeleteUserData(ctx context.Context, userID string) (deleted bool, entriesRemoved, tokensRemoved int, reason string, err error) {
	owned, err := s.ListOwnedProjects(ctx, userID)
	if err != nil {
		return false, 0, 0, "", err
	}
	if len(owned) > 0 {
		return false, 0, 0, "user still owns " + itoa(len(owned)) + " project(s)", nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, 0, 0, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Vectors this user wrote into OTHER users' projects: park their ids
	// so the reaper deletes them point-by-point (pgvector's
	// DeleteAllForUser gets them directly and these rows clear as no-ops).
	if _, err = tx.Exec(ctx, `
		INSERT INTO cold_orphans (id, user_id, namespace, project_id, attempts, last_error, last_attempt_at)
		SELECT id, user_id, namespace, project_id, 0, 'user teardown', NULL
		  FROM memory_entries
		 WHERE user_id = $1 AND project_id IS NOT NULL
		ON CONFLICT (id) DO NOTHING`, userID); err != nil {
		return false, 0, 0, "", err
	}
	for _, q := range []string{
		`DELETE FROM memory_access WHERE entry_id IN (SELECT id FROM memory_entries WHERE user_id = $1)`,
		`DELETE FROM memory_fts WHERE user_id = $1`,
		`DELETE FROM memory_relations WHERE user_id = $1`,
	} {
		if _, err = tx.Exec(ctx, q, userID); err != nil {
			return false, 0, 0, "", err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM memory_entries WHERE user_id = $1`, userID)
	if err != nil {
		return false, 0, 0, "", err
	}
	entriesRemoved = int(tag.RowsAffected())
	for _, q := range []string{
		`DELETE FROM cold_orphans WHERE user_id = $1`,
		`DELETE FROM project_members WHERE user_id = $1`,
		`DELETE FROM user_active_project WHERE user_id = $1`,
	} {
		if _, err = tx.Exec(ctx, q, userID); err != nil {
			return false, 0, 0, "", err
		}
	}
	tag, err = tx.Exec(ctx, `DELETE FROM user_tokens WHERE user_id = $1`, userID)
	if err != nil {
		return false, 0, 0, "", err
	}
	tokensRemoved = int(tag.RowsAffected())
	// Per-user telemetry, then the Better Auth rows (sessions and
	// credential accounts before the user row itself).
	for _, q := range []string{
		`DELETE FROM metrics_samples WHERE user_id = $1`,
		`DELETE FROM session WHERE "userId" = $1`,
		`DELETE FROM account WHERE "userId" = $1`,
		`DELETE FROM "user" WHERE id = $1`,
	} {
		if _, err = tx.Exec(ctx, q, userID); err != nil {
			return false, 0, 0, "", err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return false, 0, 0, "", err
	}
	return true, entriesRemoved, tokensRemoved, "", nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// CreateUser writes the Better Auth rows a signUpEmail call would have
// written: the `user` row plus its credential `account` row carrying the
// scrypt hash in Better Auth's own format. Returns ("", nil) when the
// email is already taken (the one policy failure an admin can act on).
func (s *Store) CreateUser(ctx context.Context, email, password, name string) (string, error) {
	hash, err := auth.HashPassword(password)
	if err != nil {
		return "", err
	}
	id := auth.NewID()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var existing string
	err = tx.QueryRow(ctx, `SELECT id FROM "user" WHERE lower(email) = lower($1)`, email).Scan(&existing)
	if err == nil {
		return "", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO "user" (id, email, name, "emailVerified", role, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, false, 'user', now(), now())`, id, email, name); err != nil {
		return "", err
	}
	// Better Auth's credential account: accountId = userId, providerId
	// = "credential", password = the scrypt hash.
	if _, err = tx.Exec(ctx, `
		INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
		VALUES ($1, $2, 'credential', $2, $3, now(), now())`, auth.NewID(), id, hash); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// RevokeUserToken soft-revokes a bearer by plaintext. Idempotent: false
// when the token is unknown or already revoked.
func (s *Store) RevokeUserToken(ctx context.Context, plaintext string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE user_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
		auth.HashToken(plaintext))
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// SetUserQuota upserts the per-user overrides; nil clears back to the
// server default.
func (s *Store) SetUserQuota(ctx context.Context, userID string, maxEntries, writesPerMinute *int) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO user_quotas (user_id, max_entries, writes_per_minute)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET
		  max_entries = EXCLUDED.max_entries,
		  writes_per_minute = EXCLUDED.writes_per_minute,
		  updated_at = now()`, userID, maxEntries, writesPerMinute)
	return err
}

// AuditEntry is one row of GET /v1/admin/audit-log.
type AuditEntry struct {
	ID          int64          `json:"id"`
	TS          string         `json:"ts"`
	ActorUserID *string        `json:"actorUserId"`
	ActorLabel  string         `json:"actorLabel"`
	Action      string         `json:"action"`
	Target      *string        `json:"target"`
	Metadata    map[string]any `json:"metadata"`
	RequestIP   *string        `json:"requestIp"`
}

func (s *Store) ListAuditLog(ctx context.Context, limit int) ([]AuditEntry, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id, ts, actor_user_id, actor_label, action, target, metadata, request_ip
		  FROM admin_audit_log ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		var ts time.Time
		if err := rows.Scan(&e.ID, &ts, &e.ActorUserID, &e.ActorLabel, &e.Action, &e.Target, &e.Metadata, &e.RequestIP); err != nil {
			return nil, err
		}
		e.TS = ts.UTC().Format("2006-01-02T15:04:05.000Z")
		out = append(out, e)
	}
	return out, rows.Err()
}

// ─── Background-job queries ────────────────────────────────────────────

// PendingEntry is a row awaiting an embedding (or graph enrichment).
type PendingEntry struct {
	ID        string
	UserID    string
	ProjectID *string
	Content   string
	Namespace string
	Source    string
	AgentName *string
}

// ListPendingEmbedding — entries stored with no vector, oldest first.
func (s *Store) ListPendingEmbedding(ctx context.Context, limit int) ([]PendingEntry, error) {
	return s.listPending(ctx, `
		SELECT id, user_id, project_id, content, namespace, source, agent_name
		  FROM memory_entries WHERE embedded_at IS NULL
		 ORDER BY created_at ASC LIMIT $1`, limit)
}

// ListPendingEnrichment — entries whose graph enrichment was deferred.
func (s *Store) ListPendingEnrichment(ctx context.Context, limit int) ([]PendingEntry, error) {
	return s.listPending(ctx, `
		SELECT id, user_id, project_id, content, namespace, source, agent_name
		  FROM memory_entries WHERE graph_pending_at IS NOT NULL
		 ORDER BY graph_pending_at ASC LIMIT $1`, limit)
}

// PendingFactEntry — the fields storeFactsForChunk needs to re-run
// extraction: sensitivity travels inside metadata, source is the parent
// provenance (warm-store/index.ts listPendingFacts).
type PendingFactEntry struct {
	ID        string
	UserID    string
	ProjectID *string
	Content   string
	Namespace string
	Source    string
	Metadata  map[string]any
}

// ListPendingFacts claims one bounded reconciler batch, oldest-marked
// first. Claim-on-read: the marker is RE-ARMED to now() in the same
// statement that selects the batch, with SKIP LOCKED, so replicas racing
// on the same tick claim DISJOINT rows instead of all fetching the same
// oldest-N slice and tripling the LLM spend. Re-arming (rather than
// clearing) keeps the crash contract — a worker that dies mid-batch
// leaves the marker set and the row comes back round. The final SELECT
// re-orders by the pre-update marker because UPDATE ... RETURNING makes
// no row-order guarantee.
func (s *Store) ListPendingFacts(ctx context.Context, limit int) ([]PendingFactEntry, error) {
	rows, err := s.Pool.Query(ctx, `
		WITH claimed AS (
		  SELECT id, facts_pending_at AS claimed_at FROM memory_entries
		   WHERE facts_pending_at IS NOT NULL
		   ORDER BY facts_pending_at ASC
		   LIMIT $1
		     FOR UPDATE SKIP LOCKED
		), updated AS (
		  UPDATE memory_entries m SET facts_pending_at = now()
		    FROM claimed c WHERE m.id = c.id
		  RETURNING m.id, m.user_id, m.project_id, m.content, m.namespace, m.source, m.metadata
		)
		SELECT u.* FROM updated u JOIN claimed c ON c.id = u.id
		 ORDER BY c.claimed_at ASC`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PendingFactEntry{}
	for rows.Next() {
		var e PendingFactEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.ProjectID, &e.Content, &e.Namespace, &e.Source, &e.Metadata); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) listPending(ctx context.Context, sql string, limit int) ([]PendingEntry, error) {
	rows, err := s.Pool.Query(ctx, sql, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PendingEntry{}
	for rows.Next() {
		var e PendingEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.ProjectID, &e.Content, &e.Namespace, &e.Source, &e.AgentName); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// CountRows runs one of the gauge/backlog counts. Kept as a single
// helper because every caller is "SELECT count(*) FROM x WHERE y".
func (s *Store) countRows(ctx context.Context, sql string, args ...any) (int, error) {
	var n int64
	if err := s.Pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		return 0, err
	}
	return int(n), nil
}

func (s *Store) CountPendingEmbedding(ctx context.Context) (int, error) {
	return s.countRows(ctx, `SELECT count(*) FROM memory_entries WHERE embedded_at IS NULL`)
}

func (s *Store) CountPendingEnrichment(ctx context.Context) (int, error) {
	return s.countRows(ctx, `SELECT count(*) FROM memory_entries WHERE graph_pending_at IS NOT NULL`)
}

func (s *Store) CountPendingFacts(ctx context.Context) (int, error) {
	return s.countRows(ctx, `SELECT count(*) FROM memory_entries WHERE facts_pending_at IS NOT NULL`)
}

func (s *Store) CountEntries(ctx context.Context, cold bool) (int, error) {
	return s.countRows(ctx, `SELECT count(*) FROM memory_entries WHERE cold = $1`, cold)
}

func (s *Store) CountEntriesFor(ctx context.Context, userID string, cold bool) (int, error) {
	return s.countRows(ctx, `SELECT count(*) FROM memory_entries WHERE user_id = $1 AND cold = $2`, userID, cold)
}

func (s *Store) CountRelations(ctx context.Context) (int, error) {
	return s.countRows(ctx, `SELECT count(*) FROM memory_relations`)
}

func (s *Store) CountColdOrphans(ctx context.Context) (int, error) {
	return s.countRows(ctx, `SELECT count(*) FROM cold_orphans`)
}

// PruneChanges drops memory_changes rows older than `days` (changelog
// retention; the decay loop calls it).
func (s *Store) PruneChanges(ctx context.Context, days int) (int, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM memory_changes WHERE at < now() - make_interval(days => $1)`, days)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// RecordMetricsSamples appends the per-user 1-minute throughput buckets,
// accumulating on conflict so a double flush into the same minute can't
// lose an observation.
func (s *Store) RecordMetricsSamples(ctx context.Context, userIDs []string, sampledAt time.Time, queries, remembers []int) error {
	if len(userIDs) == 0 {
		return nil
	}
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO metrics_samples (user_id, sampled_at, queries, remembers)
		SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::int[], $4::int[])
		ON CONFLICT (user_id, sampled_at) DO UPDATE SET
		  queries = metrics_samples.queries + EXCLUDED.queries,
		  remembers = metrics_samples.remembers + EXCLUDED.remembers`,
		userIDs, repeatTime(sampledAt, len(userIDs)), queries, remembers)
	return err
}

func repeatTime(t time.Time, n int) []time.Time {
	out := make([]time.Time, n)
	for i := range out {
		out[i] = t
	}
	return out
}

func (s *Store) PruneMetricsSamples(ctx context.Context, olderThan time.Time) (int, error) {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM metrics_samples WHERE sampled_at < $1`, olderThan)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// GetEngineState / SetEngineState — small durable key/value for
// background jobs (the dream-cycle cursor).
func (s *Store) GetEngineState(ctx context.Context, key string) (string, error) {
	var v string
	err := s.Pool.QueryRow(ctx, `SELECT value FROM engine_state WHERE key = $1`, key).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (s *Store) SetEngineState(ctx context.Context, key, value string) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO engine_state (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, key, value)
	return err
}

// Ping is the warm-tier half of /v1/admin/health/deep.
func (s *Store) Ping(ctx context.Context) bool { return s.Pool.Ping(ctx) == nil }
