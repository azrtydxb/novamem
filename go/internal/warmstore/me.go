// Reads behind /v1/me/*. Transcribed from warm-store/index.ts
// (exportEntries, listChanges, listRecentActivity, listProjectMembers,
// getMetricsHistory).
package warmstore

import (
	"context"
	"time"
)

// ExportEntries — keyset-paged dump of every entry the user owns (any
// scope), id-ordered so `afterId` is a stable resume cursor.
func (s *Store) ExportEntries(ctx context.Context, userID, afterID string, limit int) ([]Entry, error) {
	if limit < 1 {
		limit = 500
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT `+entryColumns+` FROM memory_entries
		 WHERE user_id = $1 AND ($2 = '' OR id > $2)
		 ORDER BY id ASC LIMIT $3`, userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

type Change struct {
	Seq       int64          `json:"seq"`
	EntryID   string         `json:"entryId"`
	ProjectID *string        `json:"projectId"`
	Change    string         `json:"change"`
	Detail    map[string]any `json:"detail"`
	At        time.Time      `json:"at"`
}

// ListChanges — the caller's changelog, oldest-first, strictly after
// `since` and/or `afterSeq` (seq is the stable cursor; timestamps collide).
func (s *Store) ListChanges(ctx context.Context, userID string, since *time.Time, afterSeq *int64, limit int) ([]Change, error) {
	if limit < 1 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT seq, entry_id, project_id, change, detail, at FROM memory_changes
		 WHERE user_id = $1
		   AND ($2::timestamptz IS NULL OR at > $2)
		   AND ($3::bigint IS NULL OR seq > $3)
		 ORDER BY seq ASC LIMIT $4`, userID, since, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Change{}
	for rows.Next() {
		var c Change
		if err := rows.Scan(&c.Seq, &c.EntryID, &c.ProjectID, &c.Change, &c.Detail, &c.At); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

type Activity struct {
	Kind    string  `json:"kind"` // remember | token | project | audit
	At      string  `json:"at"`
	Text    string  `json:"text"`
	Project *string `json:"project"`
}

// ListRecentActivity — the "Today" feed: a four-arm UNION ALL over
// remembers, token mints, project joins and this user's audit rows,
// newest first.
func (s *Store) ListRecentActivity(ctx context.Context, userID string, limit int) ([]Activity, error) {
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT 'remember'::text, created_at, left(content, 160), project_id
		  FROM memory_entries
		 WHERE (user_id = $1 AND project_id IS NULL)
		    OR EXISTS (SELECT 1 FROM project_members pm
		                WHERE pm.project_id = memory_entries.project_id AND pm.user_id = $1)
		UNION ALL
		SELECT 'token'::text, created_at, 'Minted token: ' || COALESCE(label, '(no label)'), NULL::text
		  FROM user_tokens WHERE user_id = $1 AND revoked_at IS NULL
		UNION ALL
		SELECT 'project'::text, joined_at, 'Joined project: ' || project_id, project_id
		  FROM project_members WHERE user_id = $1
		UNION ALL
		SELECT 'audit'::text, ts, action || ' ' || COALESCE(target, ''), NULL::text
		  FROM admin_audit_log WHERE actor_user_id = $1
		 ORDER BY 2 DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Activity{}
	for rows.Next() {
		var a Activity
		var at time.Time
		if err := rows.Scan(&a.Kind, &at, &a.Text, &a.Project); err != nil {
			return nil, err
		}
		a.At = at.UTC().Format("2006-01-02T15:04:05.000Z")
		out = append(out, a)
	}
	return out, rows.Err()
}

type Member struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Role     string `json:"role"`
	JoinedAt string `json:"joinedAt"`
}

func (s *Store) ListProjectMembers(ctx context.Context, projectID string) ([]Member, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT pm.user_id, u.email, pm.role, pm.joined_at
		  FROM project_members pm JOIN "user" u ON u.id = pm.user_id
		 WHERE pm.project_id = $1 ORDER BY pm.joined_at ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Member{}
	for rows.Next() {
		var m Member
		var joined time.Time
		if err := rows.Scan(&m.UserID, &m.Username, &m.Role, &joined); err != nil {
			return nil, err
		}
		m.JoinedAt = joined.UTC().Format("2006-01-02T15:04:05.000Z")
		out = append(out, m)
	}
	return out, rows.Err()
}

// WriteAudit appends an admin_audit_log row (http.ts's audit()).
// Best-effort by contract: callers log and continue on failure — an
// audit gap is preferable to a 500 on the action itself.
func (s *Store) WriteAudit(ctx context.Context, actorUserID *string, actorLabel, action string, target *string, metadata map[string]any, requestIP string) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO admin_audit_log (actor_user_id, actor_label, action, target, metadata, request_ip)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		actorUserID, actorLabel, action, target, metadata, requestIP)
	return err
}

type MetricsSample struct {
	SampledAt string `json:"sampledAt"`
	Queries   int    `json:"queries"`
	Remembers int    `json:"remembers"`
}

// GetMetricsHistory — samples for one user since `since`, oldest first.
// The sampler that writes these rows is slice 6 (background jobs); until
// it lands the Go server serves whatever the TS server left behind.
func (s *Store) GetMetricsHistory(ctx context.Context, userID string, since time.Time) ([]MetricsSample, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT sampled_at, queries, remembers FROM metrics_samples
		 WHERE user_id = $1 AND sampled_at >= $2 ORDER BY sampled_at ASC`, userID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MetricsSample{}
	for rows.Next() {
		var m MetricsSample
		var at time.Time
		if err := rows.Scan(&at, &m.Queries, &m.Remembers); err != nil {
			return nil, err
		}
		m.SampledAt = at.UTC().Format("2006-01-02T15:04:05.000Z")
		out = append(out, m)
	}
	return out, rows.Err()
}
