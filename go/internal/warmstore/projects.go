// Project lookups needed by the route-layer access checks. Transcribed
// from warm-store/index.ts getProject / findProjectByName /
// getProjectMembership / getActiveProject.
package warmstore

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// GetProject by id. Returns ("", false) when absent.
func (s *Store) GetProject(ctx context.Context, id string) (projectID string, found bool, err error) {
	err = s.Pool.QueryRow(ctx, `SELECT id FROM projects WHERE id = $1 LIMIT 1`, id).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return projectID, err == nil, err
}

// FindProjectByName — a name the user is a member of, oldest first.
func (s *Store) FindProjectByName(ctx context.Context, userID, name string) (projectID string, found bool, err error) {
	err = s.Pool.QueryRow(ctx, `
		SELECT p.id FROM projects p
		INNER JOIN project_members pm ON pm.project_id = p.id
		WHERE p.name = $1 AND pm.user_id = $2
		ORDER BY p.created_at ASC LIMIT 1`, name, userID).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return projectID, err == nil, err
}

// GetProjectMembership — true when the user is a member.
func (s *Store) GetProjectMembership(ctx context.Context, projectID, userID string) (bool, error) {
	var role string
	err := s.Pool.QueryRow(ctx, `
		SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 LIMIT 1`,
		projectID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// GetActiveProject — the user's "current sub-brain" pointer, or "".
func (s *Store) GetActiveProject(ctx context.Context, userID string) (string, error) {
	var projectID string
	err := s.Pool.QueryRow(ctx,
		`SELECT project_id FROM user_active_project WHERE user_id = $1 LIMIT 1`, userID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return projectID, err
}

// ─── Project lifecycle (MCP project_* tools) ─────────────────────────
// Transcribed from warm-store/index.ts: createProject, listProjectsForUser,
// setActiveProject, addProjectMember, removeProjectMember, deleteProject,
// findUserByExactEmail.

type Project struct {
	ID          string
	Name        string
	OwnerUserID string
	CreatedAt   time.Time
}

// GetProjectInfo — the full project row (ownership checks need the owner).
func (s *Store) GetProjectInfo(ctx context.Context, id string) (*Project, error) {
	var p Project
	err := s.Pool.QueryRow(ctx,
		`SELECT id, name, owner_user_id, created_at FROM projects WHERE id = $1 LIMIT 1`, id,
	).Scan(&p.ID, &p.Name, &p.OwnerUserID, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// CreateProject inserts the project and its owner membership row in one
// transaction (id is a server-assigned ULID minted by the caller).
func (s *Store) CreateProject(ctx context.Context, id, name, ownerUserID string) (*Project, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	p := Project{ID: id, Name: name, OwnerUserID: ownerUserID}
	if err := tx.QueryRow(ctx, `
		INSERT INTO projects (id, name, owner_user_id)
		VALUES ($1, $2, $3) RETURNING created_at`, id, name, ownerUserID).Scan(&p.CreatedAt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO project_members (project_id, user_id, role)
		VALUES ($1, $2, 'owner')`, id, ownerUserID); err != nil {
		return nil, err
	}
	return &p, tx.Commit(ctx)
}

type ProjectMembership struct {
	ID          string
	Name        string
	Role        string
	OwnerUserID string
	CreatedAt   time.Time
}

// ListProjectsForUser — every project the user is a member of, oldest first.
func (s *Store) ListProjectsForUser(ctx context.Context, userID string) ([]ProjectMembership, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT p.id, p.name, pm.role, p.owner_user_id, p.created_at
		  FROM projects p
		  INNER JOIN project_members pm ON pm.project_id = p.id
		 WHERE pm.user_id = $1
		 ORDER BY p.created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProjectMembership{}
	for rows.Next() {
		var m ProjectMembership
		if err := rows.Scan(&m.ID, &m.Name, &m.Role, &m.OwnerUserID, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SetActiveProject sets or clears the user's "current sub-brain" pointer.
func (s *Store) SetActiveProject(ctx context.Context, userID string, projectID *string) error {
	if projectID == nil {
		_, err := s.Pool.Exec(ctx, `DELETE FROM user_active_project WHERE user_id = $1`, userID)
		return err
	}
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO user_active_project (user_id, project_id, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (user_id) DO UPDATE SET project_id = EXCLUDED.project_id, updated_at = now()`,
		userID, *projectID)
	return err
}

// AddProjectMember — false when the user was already a member.
func (s *Store) AddProjectMember(ctx context.Context, projectID, userID, role string) (bool, error) {
	tag, err := s.Pool.Exec(ctx, `
		INSERT INTO project_members (project_id, user_id, role)
		VALUES ($1, $2, $3) ON CONFLICT (project_id, user_id) DO NOTHING`,
		projectID, userID, role)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RemoveProjectMember — false when there was nothing to remove. Tokens
// are user-scoped, not project-scoped, so nothing else is revoked.
func (s *Store) RemoveProjectMember(ctx context.Context, projectID, userID string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, projectID, userID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// DeleteProject hard-deletes a project: its entries (with their FTS /
// access / relations rows), parked orphans, member rows and the project
// row itself, in one transaction. Cold-store cleanup is the engine's job.
func (s *Store) DeleteProject(ctx context.Context, id string) (deleted bool, entriesRemoved int, err error) {
	info, err := s.GetProjectInfo(ctx, id)
	if err != nil || info == nil {
		return false, 0, err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// memory_access has no project_id column — delete by entry-id subquery.
	if _, err := tx.Exec(ctx, `
		DELETE FROM memory_access WHERE entry_id IN (
			SELECT id FROM memory_entries WHERE project_id = $1)`, id); err != nil {
		return false, 0, err
	}
	for _, stmt := range []string{
		`DELETE FROM memory_fts WHERE project_id = $1`,
		`DELETE FROM memory_relations WHERE project_id = $1`,
	} {
		if _, err := tx.Exec(ctx, stmt, id); err != nil {
			return false, 0, err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM memory_entries WHERE project_id = $1`, id)
	if err != nil {
		return false, 0, err
	}
	entriesRemoved = int(tag.RowsAffected())
	for _, stmt := range []string{
		`DELETE FROM cold_orphans WHERE project_id = $1`,
		`DELETE FROM project_members WHERE project_id = $1`,
		`DELETE FROM user_active_project WHERE project_id = $1`,
		`DELETE FROM projects WHERE id = $1`,
	} {
		if _, err := tx.Exec(ctx, stmt, id); err != nil {
			return false, 0, err
		}
	}
	return true, entriesRemoved, tx.Commit(ctx)
}

type User struct {
	ID       string
	Username string // the full email — what every caller displays
	Role     string
}

// FindUserByExactEmail — strict, case-insensitive email-only lookup. Do
// NOT relax this: the share flow authorises on it, and `name` is
// self-settable and not unique.
func (s *Store) FindUserByExactEmail(ctx context.Context, email string) (*User, error) {
	var u User
	var role *string
	err := s.Pool.QueryRow(ctx,
		`SELECT id, email, role FROM "user" WHERE lower(email) = lower($1) LIMIT 1`, email,
	).Scan(&u.ID, &u.Username, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	u.Role = "user"
	if role != nil {
		u.Role = *role
	}
	return &u, nil
}
