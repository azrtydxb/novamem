// Project lookups needed by the route-layer access checks. Transcribed
// from warm-store/index.ts getProject / findProjectByName /
// getProjectMembership / getActiveProject.
package warmstore

import (
	"context"
	"errors"

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
